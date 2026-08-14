<?php

namespace App\Support;

/**
 * Built-in base templates. Each is a ready-to-use base — tables, typed fields (single-selects
 * carry coloured choices so Kanban works immediately), and realistic sample rows. The
 * TemplateController turns a chosen template into a real base.
 */
final class Templates
{
    /** @return array<int,array> the catalogue (summaries include everything the gallery needs) */
    public static function all(): array
    {
        return [self::projectTracker(), self::salesCrm(), self::contentCalendar()];
    }

    public static function find(string $id): ?array
    {
        foreach (self::all() as $t) {
            if ($t['id'] === $id) {
                return $t;
            }
        }

        return null;
    }

    private static function sel(array ...$choices): array
    {
        return ['choices' => array_map(fn ($c) => ['id' => $c[0], 'label' => $c[1], 'color' => $c[2]], $choices)];
    }

    private static function projectTracker(): array
    {
        return [
            'id' => 'project-tracker',
            'name' => 'Project Tracker',
            'category' => 'Project Management',
            'icon' => '🚀',
            'description' => 'Plan projects and tasks with statuses, priorities, owners and due dates.',
            'tables' => [
                [
                    'name' => 'Projects',
                    'fields' => [
                        ['name' => 'Name', 'type' => 'singleLineText', 'primary' => true],
                        ['name' => 'Status', 'type' => 'singleSelect', 'options' => self::sel(['planning', 'Planning', '#64748b'], ['active', 'Active', '#2563eb'], ['done', 'Done', '#16a34a'])],
                        ['name' => 'Priority', 'type' => 'singleSelect', 'options' => self::sel(['low', 'Low', '#64748b'], ['high', 'High', '#f59e0b'], ['urgent', 'Urgent', '#dc2626'])],
                        ['name' => 'Owner', 'type' => 'singleLineText'],
                        ['name' => 'Due Date', 'type' => 'date'],
                    ],
                    'rows' => [
                        ['Website Launch', 'active', 'high', 'Alex', '2026-09-01'],
                        ['Mobile App', 'planning', 'urgent', 'Sam', '2026-10-15'],
                        ['Brand Refresh', 'done', 'low', 'Jo', '2026-06-30'],
                    ],
                ],
                [
                    'name' => 'Tasks',
                    'fields' => [
                        ['name' => 'Task', 'type' => 'singleLineText', 'primary' => true],
                        ['name' => 'Status', 'type' => 'singleSelect', 'options' => self::sel(['todo', 'To do', '#64748b'], ['doing', 'Doing', '#2563eb'], ['done', 'Done', '#16a34a'])],
                        ['name' => 'Assignee', 'type' => 'singleLineText'],
                        ['name' => 'Due', 'type' => 'date'],
                    ],
                    'rows' => [
                        ['Design mockups', 'doing', 'Alex', '2026-08-20'],
                        ['Set up hosting', 'todo', 'Sam', '2026-08-25'],
                        ['Write copy', 'done', 'Jo', '2026-08-10'],
                    ],
                ],
            ],
        ];
    }

    private static function salesCrm(): array
    {
        return [
            'id' => 'sales-crm',
            'name' => 'Sales CRM',
            'category' => 'CRM',
            'icon' => '💼',
            'description' => 'Track leads, deals and companies through your sales pipeline.',
            'tables' => [
                [
                    'name' => 'Deals',
                    'fields' => [
                        ['name' => 'Deal', 'type' => 'singleLineText', 'primary' => true],
                        ['name' => 'Stage', 'type' => 'singleSelect', 'options' => self::sel(['lead', 'Lead', '#64748b'], ['negotiation', 'Negotiation', '#f59e0b'], ['won', 'Won', '#16a34a'], ['lost', 'Lost', '#dc2626'])],
                        ['name' => 'Value', 'type' => 'currency'],
                        ['name' => 'Contact', 'type' => 'singleLineText'],
                        ['name' => 'Close Date', 'type' => 'date'],
                    ],
                    'rows' => [
                        ['Acme Corp', 'negotiation', 48000, 'buyer@acme.com', '2026-09-15'],
                        ['Globex', 'lead', 12500, 'cto@globex.com', '2026-10-01'],
                        ['Initech', 'won', 96000, 'ops@initech.com', '2026-07-20'],
                    ],
                ],
                [
                    'name' => 'Companies',
                    'fields' => [
                        ['name' => 'Company', 'type' => 'singleLineText', 'primary' => true],
                        ['name' => 'Industry', 'type' => 'singleLineText'],
                        ['name' => 'Website', 'type' => 'url'],
                    ],
                    'rows' => [
                        ['Acme Corp', 'Manufacturing', 'https://acme.example'],
                        ['Globex', 'Technology', 'https://globex.example'],
                    ],
                ],
            ],
        ];
    }

    private static function contentCalendar(): array
    {
        return [
            'id' => 'content-calendar',
            'name' => 'Content Calendar',
            'category' => 'Marketing',
            'icon' => '📅',
            'description' => 'Plan and schedule content across channels with a publish calendar.',
            'tables' => [
                [
                    'name' => 'Content',
                    'fields' => [
                        ['name' => 'Title', 'type' => 'singleLineText', 'primary' => true],
                        ['name' => 'Status', 'type' => 'singleSelect', 'options' => self::sel(['idea', 'Idea', '#64748b'], ['draft', 'Draft', '#f59e0b'], ['scheduled', 'Scheduled', '#2563eb'], ['published', 'Published', '#16a34a'])],
                        ['name' => 'Channel', 'type' => 'singleSelect', 'options' => self::sel(['blog', 'Blog', '#a855f7'], ['email', 'Email', '#2563eb'], ['social', 'Social', '#ec4899'])],
                        ['name' => 'Author', 'type' => 'singleLineText'],
                        ['name' => 'Publish Date', 'type' => 'date'],
                    ],
                    'rows' => [
                        ['Launch announcement', 'scheduled', 'blog', 'Alex', '2026-09-01'],
                        ['Weekly newsletter', 'draft', 'email', 'Sam', '2026-08-22'],
                        ['Product teaser', 'published', 'social', 'Jo', '2026-08-05'],
                    ],
                ],
            ],
        ];
    }
}
