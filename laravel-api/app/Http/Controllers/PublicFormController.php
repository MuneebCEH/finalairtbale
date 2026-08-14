<?php

namespace App\Http\Controllers;

use App\Models\Field;
use App\Models\Form;
use App\Models\Record;
use App\Models\Table;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * The public face of a form: a self-contained HTML page anyone with the link can open and submit,
 * with no account. Only the fields the form exposes are rendered or accepted, and a submission
 * creates exactly one record in the form's table. Unauthenticated by design — no tenant context.
 */
class PublicFormController extends Controller
{
    public function show(string $slug): Response
    {
        $form = $this->publishedForm($slug);
        if (! $form) {
            return $this->page('Form not found', '<p>This form is not available.</p>', 404);
        }

        return $this->page($form->title, $this->formBody($form, []));
    }

    public function submit(Request $request, string $slug): Response
    {
        $form = $this->publishedForm($slug);
        if (! $form) {
            return $this->page('Form not found', '<p>This form is not available.</p>', 404);
        }

        [$data, $errors] = $this->collect($request, $form);
        if (! empty($errors)) {
            return $this->page($form->title, $this->formBody($form, $errors, $request->all()), 422);
        }

        DB::transaction(function () use ($form, $data) {
            $table = Table::whereKey($form->table_id)->lockForUpdate()->first();
            $seq = ((int) $table->auto_number_seq) + 1;
            $table->forceFill([
                'auto_number_seq' => $seq,
                'record_count' => ((int) $table->record_count) + 1,
            ])->save();

            Record::create([
                'organization_id' => $form->organization_id,
                'table_id' => $form->table_id,
                'data' => $data,
                'version' => 1,
                'auto_number' => $seq,
                'created_at' => Carbon::now(),
                'updated_at' => Carbon::now(),
            ]);

            Form::whereKey($form->id)->update(['submission_count' => DB::raw('submission_count + 1')]);
        });

        $message = $form->config['confirmationMessage'] ?? 'Thanks for your response!';

        return $this->page($form->title, '<div class="done">✓ '.e($message).'</div>');
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    private function publishedForm(string $slug): ?Form
    {
        return Form::where('slug', $slug)->where('is_published', true)->whereNull('deleted_at')->first();
    }

    /** @return array<int,array{0:Field,1:array}> visible fields with their config */
    private function visibleFields(Form $form): array
    {
        $byId = Field::where('table_id', $form->table_id)->whereNull('deleted_at')->get()->keyBy('id');
        $out = [];
        foreach (($form->config['fields'] ?? []) as $entry) {
            if (! empty($entry['hidden'])) {
                continue;
            }
            $field = $byId->get($entry['fieldId'] ?? '');
            if ($field && ! in_array($field->type, ['linkedRecord', 'parentRecord', 'childRecords', 'attachment'], true)
                && ! in_array($field->type, \App\Support\FieldTypes::COMPUTED, true)) {
                $out[] = [$field, $entry];
            }
        }

        return $out;
    }

    /** @return array{0:array,1:array} [recordData, errors] */
    private function collect(Request $request, Form $form): array
    {
        $data = [];
        $errors = [];
        foreach ($this->visibleFields($form) as [$field, $entry]) {
            $raw = $request->input('f_'.$field->id);
            $value = $this->coerce($field->type, $raw);
            if (! empty($entry['required']) && ($value === null || $value === '' || $value === [])) {
                $errors[$field->id] = 'This field is required.';
            }
            if ($value !== null) {
                $data[$field->id] = $value;
            }
        }

        return [$data, $errors];
    }

    private function coerce(string $type, mixed $raw): mixed
    {
        if ($type === 'checkbox') {
            return $raw ? true : false;
        }
        if (in_array($type, ['number', 'decimal', 'currency', 'percent', 'rating', 'progress', 'duration'], true)) {
            return ($raw === null || $raw === '') ? null : (float) $raw;
        }
        if ($type === 'multipleSelect') {
            return is_array($raw) ? array_values($raw) : ($raw ? [$raw] : []);
        }

        return ($raw === null || $raw === '') ? null : (string) $raw;
    }

    private function formBody(Form $form, array $errors, array $old = []): string
    {
        $inputs = '';
        foreach ($this->visibleFields($form) as [$field, $entry]) {
            $label = e($entry['label'] ?? $field->name).(! empty($entry['required']) ? ' <span class="req">*</span>' : '');
            $error = isset($errors[$field->id]) ? '<span class="err">'.e($errors[$field->id]).'</span>' : '';
            $inputs .= '<label class="row"><span class="lbl">'.$label.'</span>'
                .$this->input($field, $old['f_'.$field->id] ?? null).$error.'</label>';
        }
        $submit = e($form->config['submitText'] ?? 'Submit');
        $desc = $form->description ? '<p class="desc">'.e($form->description).'</p>' : '';

        return '<form method="post" action="/v1/f/'.e($form->slug).'">'
            .'<h1>'.e($form->title).'</h1>'.$desc.$inputs
            .'<button type="submit">'.$submit.'</button></form>';
    }

    private function input(Field $field, mixed $old): string
    {
        $name = 'f_'.$field->id;
        $val = e(is_string($old) ? $old : '');
        switch ($field->type) {
            case 'longText':
                return '<textarea name="'.$name.'" rows="3">'.$val.'</textarea>';
            case 'checkbox':
                return '<input type="checkbox" name="'.$name.'" value="1"'.($old ? ' checked' : '').'>';
            case 'number': case 'decimal': case 'currency': case 'percent': case 'rating':
                return '<input type="number" step="any" name="'.$name.'" value="'.$val.'">';
            case 'date':
                return '<input type="date" name="'.$name.'" value="'.$val.'">';
            case 'dateTime':
                return '<input type="datetime-local" name="'.$name.'" value="'.$val.'">';
            case 'email':
                return '<input type="email" name="'.$name.'" value="'.$val.'">';
            case 'url':
                return '<input type="url" name="'.$name.'" value="'.$val.'">';
            case 'singleSelect': case 'status': {
                $opts = '<option value="">—</option>';
                foreach (($field->options['choices'] ?? []) as $c) {
                    $sel = ($old === ($c['id'] ?? null)) ? ' selected' : '';
                    $opts .= '<option value="'.e($c['id']).'"'.$sel.'>'.e($c['label'] ?? $c['id']).'</option>';
                }
                return '<select name="'.$name.'">'.$opts.'</select>';
            }
            default:
                return '<input type="text" name="'.$name.'" value="'.$val.'">';
        }
    }

    private function page(string $title, string $body, int $status = 200): Response
    {
        $html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            .'<meta name="viewport" content="width=device-width,initial-scale=1">'
            .'<title>'.e($title).'</title><style>'
            .'*{box-sizing:border-box}body{margin:0;background:#0f1115;color:#e6e8ec;'
            .'font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;'
            .'justify-content:center;padding:32px 16px}form,.done{width:100%;max-width:520px;'
            .'background:#181b22;border:1px solid #262a33;border-radius:12px;padding:24px}'
            .'h1{margin:0 0 4px;font-size:20px}.desc{color:#9aa1ad;margin:0 0 16px}'
            .'.row{display:block;margin:0 0 14px}.lbl{display:block;margin-bottom:4px;font-size:13px;color:#c3c8d1}'
            .'.req{color:#f0743a}.err{display:block;color:#f0743a;font-size:12px;margin-top:4px}'
            .'input[type=text],input[type=email],input[type=url],input[type=number],input[type=date],'
            .'input[type=datetime-local],textarea,select{width:100%;padding:9px 11px;background:#0f1115;'
            .'border:1px solid #2b303a;border-radius:8px;color:#e6e8ec;font:inherit}'
            .'input:focus,textarea:focus,select:focus{outline:none;border-color:#3b82f6}'
            .'button{margin-top:8px;width:100%;padding:11px;background:#3b82f6;color:#fff;border:0;'
            .'border-radius:8px;font:inherit;font-weight:600;cursor:pointer}button:hover{background:#2f6fe0}'
            .'.done{text-align:center;font-size:17px;color:#4ade80}'
            .'</style></head><body>'.$body.'</body></html>';

        return response($html, $status)->header('Content-Type', 'text/html; charset=utf-8');
    }
}
