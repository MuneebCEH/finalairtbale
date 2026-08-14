<?php

namespace Database\Seeders;

use App\Models\Base;
use App\Models\Field;
use App\Models\Organization;
use App\Models\Record;
use App\Models\Table;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Carbon;

/**
 * A realistic "Project Tracker" base — Projects, Tasks, Team — with single-select statuses (so the
 * Kanban board has real coloured columns), date fields (so Calendar and Timeline render), and
 * enough sample rows that every view looks complete on first open. Idempotent.
 */
class ProjectTrackerSeeder
{
    public function run(Organization $org, Workspace $ws, User $owner): void
    {
        if (Base::where('workspace_id', $ws->id)->where('name', 'Project Tracker')->exists()) {
            return;
        }

        $base = Base::create([
            'organization_id' => $org->id,
            'workspace_id' => $ws->id,
            'name' => 'Project Tracker',
            'icon' => '🚀',
            'color' => '#2563eb',
            'created_by_id' => $owner->id,
        ]);

        $this->projects($base, $owner);
        $this->tasks($base, $owner);
        $this->team($base, $owner);
    }

    private function projects(Base $base, User $owner): void
    {
        $t = $this->table($base, 'Projects', $owner, 0);
        $name = $this->field($t, 'Name', 'singleLineText', 0, ['isPrimary' => true]);
        $status = $this->select($t, 'Status', 1, [
            ['planning', 'Planning', '#64748b'], ['active', 'Active', '#2563eb'],
            ['on_hold', 'On Hold', '#f59e0b'], ['completed', 'Completed', '#16a34a'],
        ]);
        $priority = $this->priorityField($t, 2);
        $owner_f = $this->field($t, 'Owner', 'singleLineText', 3);
        $start = $this->field($t, 'Start Date', 'date', 4);
        $due = $this->field($t, 'Due Date', 'date', 5);
        $progress = $this->field($t, 'Progress', 'percent', 6);
        $desc = $this->field($t, 'Description', 'longText', 7);

        $rows = [
            ['Website Redesign', 'active', 'high', 'Amara Okafor', '2026-08-01', '2026-09-15', 60, 'Rebuild the marketing site with the new brand.'],
            ['Mobile App v2', 'planning', 'urgent', 'Ravi Patel', '2026-09-01', '2026-11-30', 10, 'Native rewrite with offline support.'],
            ['Q3 Data Migration', 'active', 'medium', 'Mei Lin', '2026-07-15', '2026-08-30', 80, 'Move legacy records into the new warehouse.'],
            ['Brand Refresh', 'completed', 'low', 'Amara Okafor', '2026-05-01', '2026-06-20', 100, 'New logo, palette, and typography.'],
            ['Customer Portal', 'on_hold', 'high', 'Ravi Patel', '2026-08-10', '2026-10-05', 25, 'Self-service portal for enterprise clients.'],
            ['Analytics Dashboard', 'active', 'medium', 'Mei Lin', '2026-08-05', '2026-09-10', 45, 'Executive KPI dashboard.'],
        ];
        $this->fill($t, $rows, [$name, $status, $priority, $owner_f, $start, $due, $progress, $desc], $owner);
    }

    private function tasks(Base $base, User $owner): void
    {
        $t = $this->table($base, 'Tasks', $owner, 1);
        $name = $this->field($t, 'Name', 'singleLineText', 0, ['isPrimary' => true]);
        $status = $this->select($t, 'Status', 1, [
            ['backlog', 'Backlog', '#64748b'], ['in_progress', 'In Progress', '#2563eb'],
            ['review', 'Review', '#a855f7'], ['done', 'Done', '#16a34a'],
        ]);
        $priority = $this->priorityField($t, 2);
        $assignee = $this->field($t, 'Assignee', 'singleLineText', 3);
        $due = $this->field($t, 'Due Date', 'date', 4);
        $notes = $this->field($t, 'Notes', 'longText', 5);

        $rows = [
            ['Design homepage hero', 'in_progress', 'high', 'Amara Okafor', '2026-08-18', 'Three variations for review.'],
            ['Set up CI pipeline', 'done', 'medium', 'Ravi Patel', '2026-08-12', 'GitHub Actions + tests.'],
            ['Write API docs', 'backlog', 'low', 'Mei Lin', '2026-08-25', ''],
            ['User interviews', 'review', 'high', 'Amara Okafor', '2026-08-20', '5 enterprise customers.'],
            ['Migrate auth module', 'in_progress', 'urgent', 'Ravi Patel', '2026-08-16', 'Blocked on secrets.'],
            ['QA regression pass', 'backlog', 'medium', 'Mei Lin', '2026-08-28', ''],
            ['Finalize color tokens', 'done', 'low', 'Amara Okafor', '2026-08-10', ''],
            ['Load test the grid', 'backlog', 'high', 'Ravi Patel', '2026-09-02', '1M rows target.'],
        ];
        $this->fill($t, $rows, [$name, $status, $priority, $assignee, $due, $notes], $owner);
    }

    private function team(Base $base, User $owner): void
    {
        $t = $this->table($base, 'Team', $owner, 2);
        $name = $this->field($t, 'Name', 'singleLineText', 0, ['isPrimary' => true]);
        $role = $this->field($t, 'Role', 'singleLineText', 1);
        $dept = $this->select($t, 'Department', 2, [
            ['engineering', 'Engineering', '#2563eb'], ['design', 'Design', '#a855f7'],
            ['marketing', 'Marketing', '#ec4899'], ['ops', 'Operations', '#14b8a6'],
        ]);
        $email = $this->field($t, 'Email', 'email', 3);
        $active = $this->field($t, 'Active', 'checkbox', 4);

        $rows = [
            ['Amara Okafor', 'Product Lead', 'engineering', 'amara@northwind.example', true],
            ['Ravi Patel', 'Senior Engineer', 'engineering', 'ravi@northwind.example', true],
            ['Mei Lin', 'Data Analyst', 'ops', 'mei@northwind.example', true],
            ['Diego Fernandez', 'Designer', 'design', 'diego@northwind.example', true],
            ['Sara Cohen', 'Marketing Manager', 'marketing', 'sara@northwind.example', false],
        ];
        $this->fill($t, $rows, [$name, $role, $dept, $email, $active], $owner);
    }

    // ── Builders ────────────────────────────────────────────────────────────

    private function table(Base $base, string $name, User $owner, int $pos): Table
    {
        return Table::create([
            'organization_id' => $base->organization_id,
            'base_id' => $base->id,
            'name' => $name,
            'position' => $pos,
            'created_by_id' => $owner->id,
        ]);
    }

    private function field(Table $t, string $name, string $type, int $pos, array $extra = []): Field
    {
        $f = Field::create([
            'organization_id' => $t->organization_id,
            'table_id' => $t->id,
            'name' => $name,
            'type' => $type,
            'position' => $pos,
            'is_primary' => $extra['isPrimary'] ?? false,
            'options' => $extra['options'] ?? [],
            'created_by_id' => $t->created_by_id,
        ]);
        if ($f->is_primary) {
            $t->forceFill(['primary_field_id' => $f->id])->save();
        }

        return $f;
    }

    /** A single-select field whose choices carry ids, labels, and colours. */
    private function select(Table $t, string $name, int $pos, array $choices): Field
    {
        $opts = ['choices' => array_map(fn ($c) => ['id' => $c[0], 'label' => $c[1], 'color' => $c[2]], $choices)];

        return $this->field($t, $name, 'singleSelect', $pos, ['options' => $opts]);
    }

    private function priorityField(Table $t, int $pos): Field
    {
        return $this->select($t, 'Priority', $pos, [
            ['low', 'Low', '#64748b'], ['medium', 'Medium', '#2563eb'],
            ['high', 'High', '#f59e0b'], ['urgent', 'Urgent', '#dc2626'],
        ]);
    }

    /** @param array<int,array> $rows  @param Field[] $fields */
    private function fill(Table $t, array $rows, array $fields, User $owner): void
    {
        $now = Carbon::now();
        $seq = 0;
        foreach ($rows as $row) {
            $seq++;
            $data = [];
            foreach ($fields as $i => $field) {
                $data[$field->id] = $row[$i];
            }
            Record::create([
                'organization_id' => $t->organization_id,
                'table_id' => $t->id,
                'data' => $data,
                'version' => 1,
                'auto_number' => $seq,
                'created_by' => $owner->id,
                'updated_by' => $owner->id,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }
        $t->forceFill(['record_count' => count($rows), 'auto_number_seq' => $seq])->save();
    }
}
