'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/feedback';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';

import { dataApi, type Field, type RecordRow, type SavedView } from '../data/api';
import { CalendarView, GalleryView } from '../views/calendar';
import { KanbanBoard } from '../views/kanban';
import { ChartView, TimelineView } from '../views/timeline';
import { ViewToolbar, type ViewState } from '../views/toolbar';
import { ViewMenu } from '../views/view-menu';
import { ViewSwitcher, type ViewType } from '../views/view-switcher';

import { Cell, isComputed } from './cell';
import { RecordPanel } from './record-panel';
import { useVirtualRows } from './use-virtual-rows';

const ROW_HEIGHT = 32;
const ROW_NUMBER_WIDTH = 76;
const DEFAULT_COLUMN_WIDTH = 180;

interface Selection {
  row: number;
  column: number;
}

/** One rendered row: either a group band, or a record together with its index into `records`. */
type GridItem =
  | { kind: 'group'; key: string; count: number }
  | { kind: 'record'; record: RecordRow; recordIndex: number };

/**
 * A group band: the value the rows beneath share, and how many there are.
 *
 * Spans the full scroll width rather than the viewport, so the label stays with its rows when the
 * grid is scrolled sideways instead of drifting away from them.
 */
function GroupBand({
  groupKey,
  count,
  collapsed,
  width,
  onToggle,
}: {
  groupKey: string;
  count: number;
  collapsed: boolean;
  width: number;
  onToggle: () => void;
}) {
  return (
    <div role="row" style={{ height: ROW_HEIGHT, width }} className="flex">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          'sticky left-0 flex h-full w-full items-center gap-2 border-b border-line px-3',
          'bg-sunken text-left text-xs font-medium text-secondary hover:bg-accent-subtle',
        )}
      >
        <span aria-hidden="true" className="text-tertiary">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="truncate">{groupKey || 'Empty'}</span>
        <span className="ml-auto shrink-0 pr-4 font-mono tabular-nums text-tertiary">{count}</span>
      </button>
    </div>
  );
}

/**
 * A group's label for one record.
 *
 * Empty and null collapse to the same band deliberately: a column where some rows are blank and
 * others hold an empty string should not present two bands that both read as empty.
 */
function formatGroupValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(formatGroupValue).filter(Boolean).join(', ');
  if (typeof value === 'boolean') return value ? 'Checked' : 'Unchecked';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The grid.
 *
 * Three properties this is built around, in priority order:
 *
 *  1. **It must not lose an edit.** Every mutation is optimistic against the cached page and
 *     rolls back to the exact prior value on failure, so a rejected write leaves the cell showing
 *     what the server actually holds rather than what the user typed.
 *  2. **It must stay responsive as the dataset grows.** Rows are windowed; cells are memoised on
 *     their own value and selection state, so moving the cursor re-renders two cells rather than
 *     the visible grid.
 *  3. **It must be usable from the keyboard.** Arrow keys, Tab, Enter to edit, Escape to cancel,
 *     typing to replace — the interaction model people already have from every spreadsheet.
 */
export function GridView({
  tableId,
  tableName,
  baseId,
}: {
  tableId: string;
  tableName: string;
  /** Needed by attachment cells: files are stored against the base, not the table. */
  baseId: string;
}) {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Selection | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});

  /**
   * Column order, held as field ids.
   *
   * `null` means "whatever order the server sent", which is the common case and avoids pinning a
   * stale order when a field is added or removed server-side. Once the user reorders, this holds
   * their arrangement, and `orderedFields` below reconciles it against the live field list so a
   * field deleted elsewhere disappears and a new one lands at the end rather than vanishing.
   */
  const [columnOrder, setColumnOrder] = useState<string[] | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fieldsQuery = useQuery({
    queryKey: ['fields', tableId],
    queryFn: () => dataApi.listFields(tableId),
  });

  const [view, setView] = useState<ViewState>({
    sorts: [],
    groups: [],
    hiddenFieldIds: [],
    rowHeight: 'short',
  });
  const [search, setSearch] = useState('');
  const [viewType, setViewType] = useState<ViewType>('grid');

  // ── Saved views ───────────────────────────────────────────────────────────
  // The view list lives on the server; the toolbar edits `view`/`viewType` locally and the
  // effect below writes them back (debounced) to the active saved view, so a filter set up
  // today is still there tomorrow — and for everyone else on the table.

  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  /** Set while a saved config is being applied, so the save effect doesn't echo it back. */
  const applyingViewRef = useRef(false);
  const creatingDefaultViewRef = useRef(false);

  const viewsQuery = useQuery({
    queryKey: ['views', tableId],
    queryFn: () => dataApi.listViews(tableId),
  });
  const views = useMemo(() => viewsQuery.data ?? [], [viewsQuery.data]);

  const applyView = useCallback((saved: SavedView) => {
    applyingViewRef.current = true;
    setActiveViewId(saved.id);
    const config = (saved.config ?? {}) as Partial<ViewState> & { viewType?: ViewType };
    setView({
      sorts: config.sorts ?? [],
      groups: config.groups ?? [],
      hiddenFieldIds: config.hiddenFieldIds ?? [],
      rowHeight: config.rowHeight ?? 'short',
      ...(config.filter ? { filter: config.filter } : {}),
    });
    setViewType(config.viewType ?? (saved.type as ViewType) ?? 'grid');
  }, []);

  // First load: adopt the first saved view, or create the default "Grid view" when the table
  // has none yet (older tables predate saved views).
  useEffect(() => {
    if (!viewsQuery.isSuccess || activeViewId) return;
    const first = viewsQuery.data[0];
    if (first) {
      applyView(first);
    } else if (!creatingDefaultViewRef.current) {
      creatingDefaultViewRef.current = true;
      dataApi
        .createView(tableId, { name: 'Grid view', type: 'grid' })
        .then((created) => {
          setActiveViewId(created.id);
          void queryClient.invalidateQueries({ queryKey: ['views', tableId] });
        })
        .catch(() => {
          creatingDefaultViewRef.current = false;
        });
    }
  }, [viewsQuery.isSuccess, viewsQuery.data, activeViewId, applyView, tableId, queryClient]);

  // Persist toolbar changes into the active view, debounced so dragging through options makes
  // one write, not ten.
  useEffect(() => {
    if (!activeViewId) return;
    if (applyingViewRef.current) {
      applyingViewRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      void dataApi.updateView(activeViewId, {
        type: viewType,
        config: { ...view, viewType },
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [view, viewType, activeViewId]);

  // ── Row selection (checkboxes) ────────────────────────────────────────────

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const toggleSelected = useCallback((recordId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(recordId)) next.add(recordId);
      return next;
    });
  }, []);

  const deleteSelected = useMutation({
    mutationFn: async () => {
      // The bulk endpoint caps at 100 ids per call; larger selections go in slices.
      const ids = [...selectedIds];
      for (let i = 0; i < ids.length; i += 100) {
        await dataApi.deleteRecords(tableId, ids.slice(i, i + 100));
      }
    },
    onSuccess: async () => {
      setSelectedIds(new Set());
      await queryClient.invalidateQueries({ queryKey: ['records', tableId] });
    },
  });

  // The view travels to the server, not applied to the page after it arrives. Filtering a loaded
  // page client-side would filter one page of two hundred and call it the result — right-looking
  // and wrong, and worse the more data there is.
  //
  // No `as never` on the argument. The cast that used to be here let the grid send `sorts` and
  // `groups` — neither of which the server accepts — and because its schema is strict, adding a
  // sort failed the whole request and broke filtering along with it. The cast is what made a
  // rename-shaped bug invisible to the typechecker, so the types are now load-bearing.
  const recordsQuery = useQuery({
    queryKey: ['records', tableId, view.filter, view.sorts, view.groups, search],
    // Changing a filter/sort/group re-keys the query; without this the grid unmounts into a
    // loading state, which also slams shut whichever toolbar panel the user was still using.
    // Showing the previous rows until the new ones arrive is what Airtable does.
    placeholderData: (previous) => previous,
    queryFn: async () => {
      // Follows the cursor until the table is fully loaded (capped), because a grid that quietly
      // shows one page of a 289-row table reads as lost data — the exact complaint that led here.
      // Rows are windowed, so a few thousand records render fine.
      // Entries whose field was never picked (a fresh "+ Add" row) are dropped before the
      // request — they mean nothing yet, and half-built config must never break the grid.
      const sorts = view.sorts.filter((entry) => entry.fieldId);
      const groups = view.groups.filter((entry) => entry.fieldId);
      const filter =
        view.filter && view.filter.conditions.length > 0
          ? {
              ...view.filter,
              conditions: view.filter.conditions.filter(
                (condition) => !('conjunction' in condition) && condition.fieldId,
              ),
            }
          : undefined;
      const base = {
        ...(filter && filter.conditions.length > 0 ? { filter } : {}),
        ...(sorts.length > 0 ? { sort: sorts } : {}),
        // Grouping is an ordering the server applies, so grouped rows arrive already adjacent.
        // Sorting them client-side would only group the page that happened to load.
        ...(groups.length > 0 ? { group: groups } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      };
      const first = await dataApi.queryRecords(tableId, { limit: 200, ...base });
      const all = [...first.data];
      let meta = first.meta;
      const CAP = 5000;
      while (meta.hasMore && meta.nextCursor && all.length < CAP) {
        const page = await dataApi.queryRecords(tableId, {
          limit: 200,
          cursor: meta.nextCursor,
          ...base,
        });
        all.push(...page.data);
        meta = page.meta;
      }
      return { data: all, meta };
    },
  });

  const allFields = useMemo(
    () => (fieldsQuery.data ?? []).slice().sort((a, b) => a.position - b.position),
    [fieldsQuery.data],
  );

  // Hidden fields are removed from the rendered columns but kept in `allFields`, so the toolbar
  // can still offer them back.
  //
  // Ordering is applied here rather than at the header, so that cell rendering, keyboard
  // navigation and the selection column index all agree on what "column 3" means. Applying it
  // only to the headers would move the labels and leave the data behind them.
  const fields = useMemo(() => {
    const visible = allFields.filter((field) => !view.hiddenFieldIds.includes(field.id));
    if (!columnOrder) return visible;

    const byId = new Map(visible.map((field) => [field.id, field]));
    const arranged = columnOrder.flatMap((id) => {
      const field = byId.get(id);
      if (!field) return [];
      byId.delete(id);
      return [field];
    });
    // Anything the saved order doesn't mention is new; it goes at the end rather than disappearing.
    return [...arranged, ...byId.values()];
  }, [allFields, view.hiddenFieldIds, columnOrder]);

  /** Moves a column, clamping the destination so a drop past the last column is a no-op, not a hole. */
  const moveColumn = (from: number, to: number): void => {
    const target = Math.max(0, Math.min(fields.length - 1, to));
    if (from === target) return;

    setColumnOrder(() => {
      const ids = fields.map((field) => field.id);
      const [moved] = ids.splice(from, 1);
      if (moved === undefined) return ids;
      ids.splice(target, 0, moved);
      return ids;
    });
  };
  const records = recordsQuery.data?.data ?? [];

  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  /** Index into `records` of the expanded record, or null when the panel is closed. */
  const [expanded, setExpanded] = useState<number | null>(null);

  /**
   * The rendered sequence: group bands interleaved with the records under them.
   *
   * The server already returns grouped rows adjacent to each other, so this only has to notice
   * where the key changes — it never re-sorts. Grouping the loaded page client-side would group
   * one page of two hundred and present it as the answer.
   *
   * A record keeps its index into `records`, not its position in this list. Selection, the
   * keyboard cursor and `commitAt` all address rows by that index, and renumbering them here
   * would silently write edits to the wrong record once a band appeared above them.
   */
  const rows = useMemo((): GridItem[] => {
    if (view.groups.length === 0) {
      return records.map((record, index) => ({ kind: 'record', record, recordIndex: index }));
    }

    const keyOf = (record: RecordRow): string =>
      view.groups.map((group) => formatGroupValue(record.fields[group.fieldId])).join(' › ');

    const counts = new Map<string, number>();
    for (const record of records) {
      const key = keyOf(record);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const out: GridItem[] = [];
    let current: string | null = null;

    records.forEach((record, index) => {
      const key = keyOf(record);
      if (key !== current) {
        current = key;
        out.push({ kind: 'group', key, count: counts.get(key) ?? 0 });
      }
      // A collapsed band keeps its header and drops its rows; the header is how it is reopened.
      if (!collapsedGroups.has(key)) out.push({ kind: 'record', record, recordIndex: index });
    });

    return out;
  }, [records, view.groups, collapsedGroups]);

  const toggleGroup = (key: string): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const { scrollRef, range, scrollToRow } = useVirtualRows({
    rowCount: rows.length,
    rowHeight: ROW_HEIGHT,
  });

  /**
   * Per-column totals for the summary bar. Only columns whose type is genuinely additive get a
   * Sum — a text column with digit-looking values must not pretend to be money. Currency keeps
   * two decimals with a $; plain numbers show as entered.
   */
  const summaries = useMemo(() => {
    const NUMERIC = new Set(['number', 'decimal', 'currency', 'percent', 'duration', 'rating']);
    const out: Record<string, string> = {};
    for (const field of fields) {
      if (!NUMERIC.has(field.type)) continue;
      let sum = 0;
      let any = false;
      for (const record of records) {
        const value = record.fields[field.id];
        const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
        if (!Number.isNaN(n)) {
          sum += n;
          any = true;
        }
      }
      if (!any) continue;
      out[field.id] =
        field.type === 'currency'
          ? `$${sum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : field.type === 'percent'
            ? `${sum.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
            : sum.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return out;
  }, [fields, records]);

  const widthOf = useCallback(
    (field: Field) => widths[field.id] ?? DEFAULT_COLUMN_WIDTH,
    [widths],
  );

  // ── Mutations ─────────────────────────────────────────────────────────────

  const updateCell = useMutation({
    mutationFn: ({ recordId, fieldId, value, version }: {
      recordId: string;
      fieldId: string;
      value: unknown;
      version: number;
    }) => dataApi.updateRecord(tableId, recordId, { [fieldId]: value }, version),

    onMutate: async ({ recordId, fieldId, value }) => {
      await queryClient.cancelQueries({ queryKey: ['records', tableId] });
      const previous = queryClient.getQueryData(['records', tableId]);

      // Optimistic: the cell shows the new value immediately. The rollback below is what makes
      // this safe rather than merely fast.
      queryClient.setQueryData(['records', tableId], (old: typeof recordsQuery.data) => {
        if (!old) return old;
        return {
          ...old,
          data: old.data.map((row) =>
            row.id === recordId ? { ...row, fields: { ...row.fields, [fieldId]: value } } : row,
          ),
        };
      });

      return { previous };
    },

    onError: (_error, _variables, context) => {
      // Restores the exact prior page, so a rejected edit leaves the grid showing what the
      // server holds rather than the value the user typed.
      if (context?.previous) queryClient.setQueryData(['records', tableId], context.previous);
    },

    onSuccess: (updated) => {
      // Replace with the server's version of the row: it carries the authoritative version
      // number and any value the field type coerced ("$1,234.50" becoming 1234.5).
      queryClient.setQueryData(['records', tableId], (old: typeof recordsQuery.data) => {
        if (!old) return old;
        return { ...old, data: old.data.map((row) => (row.id === updated.id ? updated : row)) };
      });
    },
  });

  const addRecord = useMutation({
    mutationFn: () => dataApi.createRecords(tableId, [{ fields: {} }]),
    onSuccess: async (result) => {
      // On a table larger than one page the new record lives beyond the loaded rows, so a
      // refetch would create it invisibly — the classic "I clicked Add and nothing happened".
      // Splice it into the visible page instead; it settles into its real position on the
      // next natural refetch.
      const created = result.records ?? [];
      if (recordsQuery.data?.meta.hasMore && created.length > 0) {
        queryClient.setQueryData(
          ['records', tableId, view.filter, view.sorts, view.groups, search],
          (old: typeof recordsQuery.data) =>
            old ? { ...old, data: [...created, ...old.data] } : old,
        );
        scrollToRow(0);
        setSelection({ row: 0, column: 0 });
      } else {
        await queryClient.invalidateQueries({ queryKey: ['records', tableId] });
        if (created.length > 0) {
          // The new row is the last one; put the cursor on it so typing lands there.
          scrollToRow(records.length);
          setSelection({ row: records.length, column: 0 });
        }
      }
    },
  });

  // ── Keyboard navigation ───────────────────────────────────────────────────

  const move = useCallback(
    (rowDelta: number, columnDelta: number) => {
      setSelection((current) => {
        if (!current) return { row: 0, column: 0 };
        const row = Math.max(0, Math.min(records.length - 1, current.row + rowDelta));
        const column = Math.max(0, Math.min(fields.length - 1, current.column + columnDelta));
        scrollToRow(row);
        return { row, column };
      });
    },
    [records.length, fields.length, scrollToRow],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const handler = (event: KeyboardEvent): void => {
      if (editing) return; // The open editor owns the keyboard.

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          move(1, 0);
          break;
        case 'ArrowUp':
          event.preventDefault();
          move(-1, 0);
          break;
        case 'ArrowRight':
          event.preventDefault();
          move(0, 1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          move(0, -1);
          break;
        case 'Tab':
          event.preventDefault();
          move(0, event.shiftKey ? -1 : 1);
          break;
        case 'Enter':
          event.preventDefault();
          if (selection) {
            const field = fields[selection.column];
            if (field && !isComputed(field.type)) setEditing(selection);
          }
          break;
        case 'Escape':
          setSelection(null);
          break;
        default:
          // Typing a printable character starts editing and replaces the value, which is the
          // behaviour every spreadsheet user already has in their fingers.
          if (
            selection &&
            event.key.length === 1 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            const field = fields[selection.column];
            if (field && !isComputed(field.type)) setEditing(selection);
          }
      }
    };

    element.addEventListener('keydown', handler);
    return () => element.removeEventListener('keydown', handler);
  }, [editing, selection, fields, move]);

  /**
   * Writes a value to a cell named by its coordinates.
   *
   * Deliberately independent of `editing`. Not every write comes from the text editor: an
   * attachment upload and a checkbox toggle change a cell without it ever entering edit mode, and
   * routing those through the editor's commit made them no-ops — the upload succeeded, the file
   * reached storage, and the record was never updated. That failure is invisible from the server's
   * side, which is why the API smoke test passed while the feature did not work.
   */
  const commitAt = useCallback(
    (row: number, column: number, value: unknown) => {
      const record = records[row];
      const field = fields[column];
      if (!record || !field) return;
      if (record.fields[field.id] === value) return;

      updateCell.mutate({
        recordId: record.id,
        fieldId: field.id,
        value,
        version: record.version,
      });
    },
    [records, fields, updateCell],
  );

  /** The editor's commit: leaves edit mode, then writes through the same path as everything else. */
  const commit = useCallback(
    (value: unknown) => {
      if (!editing) return;
      const { row, column } = editing;
      setEditing(null);
      commitAt(row, column, value);
    },
    [editing, commitAt],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (fieldsQuery.isPending || recordsQuery.isPending) {
    return (
      <div className="p-6">
        <LoadingState label={`Loading ${tableName}`} />
      </div>
    );
  }

  if (fieldsQuery.isError || recordsQuery.isError) {
    const error = fieldsQuery.error ?? recordsQuery.error;
    return (
      <div className="p-6">
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load this table.'}
          {...(error instanceof ApiError ? { requestId: error.requestId } : {})}
          onRetry={() => {
            void fieldsQuery.refetch();
            void recordsQuery.refetch();
          }}
        />
      </div>
    );
  }

  const totalWidth = ROW_NUMBER_WIDTH + fields.reduce((sum, field) => sum + widthOf(field), 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1">
        <ViewMenu
          tableId={tableId}
          tableName={tableName}
          views={views}
          activeViewId={activeViewId}
          fields={fields}
          viewState={view}
          search={search}
          onSwitch={applyView}
        />
        <ViewSwitcher active={viewType} fields={allFields} onChange={setViewType} />
      </div>

      <ViewToolbar
        fields={allFields}
        state={view}
        onChange={setView}
        onSearch={setSearch}
        searchQuery={search}
        recordCount={records.length}
        canEdit
      />

      {viewType === 'kanban' && (
        <div className="min-h-0 flex-1">
          <KanbanBoard
            fields={fields}
            records={records}
            // The first stackable field. Once views are persisted this comes from the view's own
            // config; picking one here keeps the board from being unreachable in the meantime.
            stackFieldId={
              (allFields.find((field) => ['singleSelect', 'status'].includes(field.type))?.id ?? '')
            }
          />
        </div>
      )}

      {viewType === 'calendar' && (
        <div className="min-h-0 flex-1">
          <CalendarView
            fields={fields}
            records={records}
            dateFieldId={allFields.find((f) => ['date', 'dateTime'].includes(f.type))?.id ?? ''}
          />
        </div>
      )}

      {viewType === 'gallery' && (
        <div className="min-h-0 flex-1">
          <GalleryView fields={fields} records={records} />
        </div>
      )}

      {(viewType === 'timeline' || viewType === 'gantt') && (
        <div className="min-h-0 flex-1">
          <TimelineView
            fields={fields}
            records={records}
            startFieldId={allFields.find((f) => ['date', 'dateTime'].includes(f.type))?.id ?? ''}
            endFieldId={allFields.filter((f) => ['date', 'dateTime'].includes(f.type))[1]?.id}
            showDependencyNote={viewType === 'gantt'}
          />
        </div>
      )}

      {viewType === 'chart' && (
        <div className="min-h-0 flex-1">
          <ChartView
            fields={fields}
            records={records}
            xFieldId={allFields.find((f) => ['singleSelect', 'status', 'checkbox'].includes(f.type))?.id ?? allFields[0]?.id ?? ''}
          />
        </div>
      )}

      {!['grid', 'kanban', 'calendar', 'gallery', 'timeline', 'gantt', 'chart'].includes(viewType) && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-secondary">
          {/* Named plainly rather than shown as a broken-looking empty panel. */}
          The {viewType} view is not built yet. Switch back to Grid or Kanban.
        </div>
      )}

      {/* Conditionally rendered, not hidden: the HTML  attribute sets display:none and
          loses to the flex class on this element, so the grid stayed visible underneath the board. */}
      {viewType === 'grid' && (
      <div
        ref={containerRef}
        tabIndex={0}
        role="grid"
        aria-label={tableName}
        aria-rowcount={records.length}
        aria-colcount={fields.length}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
      {/* This strip appears only when it has something to say — a selection to act on or a
          failed edit. Kept out of the way otherwise so the toolbar sits right on the columns,
          the way Airtable's grid does. */}
      {(selectedIds.size > 0 || updateCell.isError) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-accent-subtle/40 px-3 py-1.5">
          {updateCell.isError && (
            <span role="alert" className="text-xs text-danger-text">
              {updateCell.error instanceof ApiError && updateCell.error.code === 'RECORD_VERSION_CONFLICT'
                ? 'Someone else changed that cell — your edit was not applied.'
                : 'That edit could not be saved.'}
            </span>
          )}
          {selectedIds.size > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-secondary">{selectedIds.size} selected</span>
              <Button
                size="sm"
                variant="danger"
                loading={deleteSelected.isPending}
                onClick={() => {
                  if (window.confirm(`Delete ${selectedIds.size} record${selectedIds.size === 1 ? '' : 's'}?`)) {
                    deleteSelected.mutate();
                  }
                }}
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                Clear
              </Button>
            </div>
          )}
        </div>
      )}

      <div ref={scrollRef} className="relative flex-1 overflow-auto">
        <div style={{ width: totalWidth }}>
          {/* Header. Sticky so column names stay visible while scrolling a long table. */}
          <div
            role="row"
            className="sticky top-0 z-20 flex border-b border-line-strong bg-sunken"
            style={{ height: ROW_HEIGHT }}
          >
            <div
              className="sticky left-0 z-30 flex shrink-0 items-center border-r border-line bg-sunken px-2"
              style={{ width: ROW_NUMBER_WIDTH }}
            >
              <input
                type="checkbox"
                aria-label="Select all records"
                checked={records.length > 0 && selectedIds.size >= records.length}
                onChange={(event) =>
                  setSelectedIds(
                    event.target.checked ? new Set(records.map((record) => record.id)) : new Set(),
                  )
                }
              />
            </div>
            {fields.map((field, columnIndex) => (
              <ColumnHeader
                key={field.id}
                field={field}
                index={columnIndex}
                width={widthOf(field)}
                isDragging={dragFrom === columnIndex}
                isDropTarget={dragOver === columnIndex && dragFrom !== columnIndex}
                onResize={(width) => setWidths((current) => ({ ...current, [field.id]: width }))}
                onDragStart={setDragFrom}
                onDragOver={setDragOver}
                onDrop={(to) => {
                  if (dragFrom !== null) moveColumn(dragFrom, to);
                  setDragFrom(null);
                  setDragOver(null);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDragOver(null);
                }}
                onMove={moveColumn}
              />
            ))}
          </div>

          {/* The windowed body. Only `range.start`..`range.end` are mounted. */}
          <div style={{ height: range.totalHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${range.offsetTop}px)` }}>
              {rows.slice(range.start, range.end).map((item) => {
                if (item.kind === 'group') {
                  return (
                    <GroupBand
                      key={`grp:${item.key}`}
                      groupKey={item.key}
                      count={item.count}
                      collapsed={collapsedGroups.has(item.key)}
                      width={totalWidth}
                      onToggle={() => toggleGroup(item.key)}
                    />
                  );
                }

                return (
                  <GridRow
                    key={item.record.id}
                    record={item.record}
                    // The record's own index, not its position in `rows` — see the note on `rows`.
                    rowIndex={item.recordIndex}
                    fields={fields}
                    baseId={baseId}
                    widthOf={widthOf}
                    selection={selection}
                    editing={editing}
                    isChecked={selectedIds.has(item.record.id)}
                    onToggleCheck={toggleSelected}
                    onSelect={(row, column) => setSelection({ row, column })}
                    onStartEdit={(row, column) => {
                      setSelection({ row, column });
                      setEditing({ row, column });
                    }}
                    onCommit={commit}
                    onCommitAt={commitAt}
                    onExpand={setExpanded}
                    onCancel={() => setEditing(null)}
                  />
                );
              })}
            </div>
          </div>

          {/* Airtable's "+" row: always at the bottom of the data, one click adds a record. */}
          <button
            type="button"
            onClick={() => addRecord.mutate()}
            disabled={addRecord.isPending}
            aria-label="Add record"
            className="flex w-full items-center border-b border-line text-left hover:bg-sunken"
            style={{ height: ROW_HEIGHT, width: totalWidth }}
          >
            <span
              className="sticky left-0 flex items-center gap-2 px-3 text-sm text-secondary"
              style={{ width: ROW_NUMBER_WIDTH * 3 }}
            >
              <span aria-hidden="true" className="text-base leading-none">+</span>
              {addRecord.isPending ? 'Adding…' : 'Add record'}
            </span>
          </button>

          {/* Airtable's summary bar: the record count at the left, and under every numeric
              column its Sum — pinned to the bottom of the scroll area, sliding sideways with
              the columns so each total stays under the column it belongs to. */}
          <div
            role="row"
            aria-label="Column summaries"
            className="sticky bottom-0 z-20 flex border-t border-line-strong bg-surface"
            style={{ height: ROW_HEIGHT, width: totalWidth }}
          >
            <div
              className="sticky left-0 z-30 flex shrink-0 items-center border-r border-line bg-surface"
              style={{ width: ROW_NUMBER_WIDTH }}
            >
              <span className="absolute left-2 whitespace-nowrap text-xs font-medium text-secondary">
                {records.length} record{records.length === 1 ? '' : 's'}
              </span>
            </div>
            {fields.map((field) => (
              <div
                key={field.id}
                className="flex shrink-0 items-center justify-end overflow-hidden border-r border-line px-2"
                style={{ width: widthOf(field) }}
              >
                {summaries[field.id] !== undefined && (
                  <span className="truncate text-xs tabular-nums text-secondary" title={`Sum of ${field.name}`}>
                    <span className="mr-1 text-2xs uppercase text-tertiary">Sum</span>
                    {summaries[field.id]}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      </div>
      )}

      {expanded !== null && records[expanded] && (
        <RecordPanel
          record={records[expanded]}
          recordIndex={expanded}
          // Every field, including ones hidden from the grid: the point of expanding a record is
          // to see all of it, and a field hidden from a column layout is not a field you are not
          // allowed to see.
          fields={allFields}
          baseId={baseId}
          tableName={tableName}
          onClose={() => setExpanded(null)}
          onCommitAt={commitAt}
          onStep={(delta) =>
            setExpanded((current) => {
              if (current === null) return current;
              // Clamped rather than wrapped: stepping past the last record should stop, not
              // silently return to the first and look like nothing happened.
              return Math.max(0, Math.min(records.length - 1, current + delta));
            })
          }
        />
      )}
    </div>
  );
}

function GridRow({
  record,
  rowIndex,
  fields,
  baseId,
  widthOf,
  selection,
  editing,
  isChecked,
  onToggleCheck,
  onSelect,
  onStartEdit,
  onCommit,
  onCommitAt,
  onExpand,
  onCancel,
}: {
  record: RecordRow;
  rowIndex: number;
  fields: Field[];
  baseId: string;
  widthOf: (field: Field) => number;
  selection: Selection | null;
  editing: Selection | null;
  isChecked: boolean;
  onToggleCheck: (recordId: string) => void;
  onSelect: (row: number, column: number) => void;
  onStartEdit: (row: number, column: number) => void;
  onCommit: (value: unknown) => void;
  onCommitAt: (row: number, column: number, value: unknown) => void;
  onExpand: (row: number) => void;
  onCancel: () => void;
}) {
  const isSelectedRow = selection?.row === rowIndex;

  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 1}
      className={cn(
        'group/row flex',
        (isSelectedRow || isChecked) && 'bg-accent-subtle/30',
      )}
      style={{ height: ROW_HEIGHT }}
    >
      {/* Row number, frozen. The checkbox appears on hover (or stays once checked), the way a
          spreadsheet keeps its margin quiet until you need to act on rows. */}
      <div
        className={cn(
          'sticky left-0 z-10 flex shrink-0 items-center gap-1 border-b border-r border-line px-2',
          'font-mono text-xs tabular-nums text-tertiary',
          isSelectedRow || isChecked ? 'bg-accent-subtle' : 'bg-surface',
        )}
        style={{ width: ROW_NUMBER_WIDTH }}
      >
        <input
          type="checkbox"
          aria-label={`Select row ${record.autoNumber}`}
          checked={isChecked}
          onChange={() => onToggleCheck(record.id)}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            isChecked ? 'block' : 'hidden group-hover/row:block',
          )}
        />
        <span className={cn('ml-auto', isChecked && 'hidden')}>{record.autoNumber}</span>
        <button
          type="button"
          aria-label={`Expand row ${record.autoNumber}`}
          onClick={(event) => {
            event.stopPropagation();
            onExpand(rowIndex);
          }}
          className={cn(
            'hidden rounded px-1 text-tertiary hover:bg-accent-subtle hover:text-accent-text',
            'group-hover/row:block focus-visible:block',
          )}
        >
          ⤢
        </button>
      </div>

      {fields.map((field, columnIndex) => (
        <Cell
          key={field.id}
          field={field}
          value={record.fields[field.id] ?? null}
          baseId={baseId}
          isSelected={selection?.row === rowIndex && selection.column === columnIndex}
          isEditing={editing?.row === rowIndex && editing.column === columnIndex}
          rowIndex={rowIndex}
          columnIndex={columnIndex}
          width={widthOf(field)}
          onSelect={onSelect}
          onStartEdit={onStartEdit}
          onCommit={onCommit}
          onCommitAt={onCommitAt}
          onCancel={onCancel}
        />
      ))}
    </div>
  );
}

/**
 * A column header: label, type glyph, drag handle and resize grip.
 *
 * Reordering is done with the native drag events rather than a pointer-tracking implementation.
 * That is deliberate: the browser handles the drag image, the escape-to-cancel behaviour and the
 * cross-window cases for free, and every one of those is something a hand-rolled version gets
 * subtly wrong.
 *
 * It is also reorderable from the keyboard. A column order that can only be changed by dragging
 * is a feature that does not exist for anybody using a keyboard or a screen reader, and this is
 * three lines of handler.
 */
function ColumnHeader({
  field,
  width,
  index,
  isDragging,
  isDropTarget,
  onResize,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMove,
}: {
  field: Field;
  width: number;
  index: number;
  isDragging: boolean;
  isDropTarget: boolean;
  onResize: (width: number) => void;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
  onMove: (from: number, to: number) => void;
}) {
  const startResize = (event: React.MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = width;

    const onMove = (moveEvent: MouseEvent): void => {
      // Clamped: a zero-width column is unrecoverable without a reset button, and a 2000px one
      // pushes every other column off screen.
      onResize(Math.max(64, Math.min(600, startWidth + moveEvent.clientX - startX)));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      role="columnheader"
      draggable
      onDragStart={(event) => {
        // Some form of data is required or Firefox refuses to start the drag at all.
        event.dataTransfer.setData('text/plain', field.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(index);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragOver(index);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(index);
      }}
      onDragEnd={onDragEnd}
      onKeyDown={(event) => {
        if (!event.altKey) return;
        if (event.key === 'ArrowLeft' && index > 0) {
          event.preventDefault();
          onMove(index, index - 1);
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          onMove(index, index + 1);
        }
      }}
      tabIndex={0}
      aria-label={`${field.name}, column ${index + 1}. Drag, or hold Alt and press the arrow keys, to reorder.`}
      className={`relative flex shrink-0 cursor-grab items-center gap-1.5 border-r border-line px-2 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        isDragging ? 'opacity-40' : ''
      } ${isDropTarget ? 'border-l-2 border-l-accent' : ''}`}
      style={{ width }}
      title={`${field.name} (${field.type})`}
    >
      <span aria-hidden="true" className="text-2xs text-tertiary">
        {typeGlyph(field.type)}
      </span>
      <span className="truncate text-xs font-medium text-secondary">{field.name}</span>
      {field.isPrimary && (
        <span className="text-2xs text-tertiary" title="Primary field">
          ●
        </span>
      )}
      {/* Non-colour cue that the column is indexed, alongside the tooltip. */}
      {field.promotedSlot && (
        <span className="ml-auto text-2xs text-tertiary" title="Indexed for filtering and sorting">
          ⚡
        </span>
      )}
      <button
        type="button"
        aria-label={`Resize ${field.name}`}
        // Without this the grip inherits the header's draggability and a resize turns into a
        // reorder the moment the pointer moves.
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onMouseDown={startResize}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-accent"
      />
    </div>
  );
}

/** A compact type indicator, so the column's behaviour is legible without opening a menu. */
function typeGlyph(type: string): string {
  const glyphs: Record<string, string> = {
    singleLineText: 'A', longText: '¶', email: '@', url: '↗', phone: '☏', barcode: '|||',
    number: '#', decimal: '#', currency: '$', percent: '%', rating: '★', progress: '▤', duration: '⏱',
    checkbox: '☑', singleSelect: '▾', multipleSelect: '▾▾', status: '◈',
    date: '▦', dateTime: '▦', user: '☺', multipleUsers: '☺☺', attachment: '📎', json: '{}',
    autoNumber: '№', recordId: 'ID', createdTime: '▦', lastModifiedTime: '▦',
    createdBy: '☺', lastModifiedBy: '☺', formula: 'ƒ', rollup: 'Σ', lookup: '↗', count: '#',
  };
  return glyphs[type] ?? '?';
}
