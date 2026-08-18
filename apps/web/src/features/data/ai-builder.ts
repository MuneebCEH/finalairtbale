/**
 * The AI workspace builder's brain: turns a free-text prompt ("mera clinic ka system banao",
 * "CRM with deals and contacts") into a complete build plan — tables, typed fields, links
 * between tables, rollups over those links, sample records, and a starter dashboard.
 *
 * Deliberately deterministic and offline: shared hosting has no LLM to call, so this is a
 * domain-template engine with a parser on top. The same prompt always yields the same plan,
 * which also makes it testable. Explicit structure in the prompt ("Patients: Name, DOB, Phone")
 * always beats the template guess.
 */

export interface PlanField {
  name: string;
  type: string;
  options?: Record<string, unknown>;
  /** For linkedRecord fields: the target table's plan name (resolved to an id at build time). */
  linkTo?: string;
  /** For rollup/lookup: which link field to travel and which target field to read. */
  via?: string;
  target?: string;
  aggregation?: string;
}

export interface PlanTable {
  name: string;
  /** The primary "Name"-like column every table gets is implicit; these are the rest. */
  fields: PlanField[];
  /** Sample rows keyed by field name; link fields hold ROW INDICES into the target table. */
  samples: Array<Record<string, unknown>>;
}

export interface PlanWidget {
  type: 'stat' | 'chart' | 'table';
  title: string;
  table: string;
  agg?: 'count' | 'sum' | 'avg';
  fieldName?: string;
  groupFieldName?: string;
}

export interface Plan {
  baseName: string;
  tables: PlanTable[];
  widgets: PlanWidget[];
  /** The assistant's human reply describing what it understood and will build. */
  summary: string;
}

/** Name → field type for user-written field lists. First match wins. */
export function guessFieldType(rawName: string): { type: string; options?: Record<string, unknown> } {
  const name = rawName.toLowerCase();
  const has = (...words: string[]) => words.some((w) => name.includes(w));

  if (has('date', 'dob', 'birth', 'deadline', 'due', 'shipped', 'delivered', 'join')) return { type: 'date' };
  if (has('amount', 'price', 'cost', 'paid', 'total', 'fee', 'salary', 'budget', 'payment', 'rent')) return { type: 'currency' };
  if (has('qty', 'quantity', 'count', 'age', 'score', 'roll no', 'stock')) return { type: 'number' };
  if (has('email')) return { type: 'email' };
  if (has('phone', 'mobile', 'whatsapp')) return { type: 'phone' };
  if (has('url', 'link', 'website')) return { type: 'url' };
  if (has('status', 'stage', 'rsvp')) return { type: 'singleSelect', options: selectOptions(['New', 'In progress', 'Done']) };
  if (has('priority')) return { type: 'singleSelect', options: selectOptions(['Low', 'Medium', 'High']) };
  if (has('notes', 'description', 'details', 'comment', 'address', 'remarks')) return { type: 'longText' };
  if (has('done', 'active', 'verified', 'checked', 'complete', 'billed')) return { type: 'checkbox' };
  return { type: 'singleLineText' };
}

function selectOptions(labels: string[], colors = ['#2563eb', '#f59e0b', '#16a34a', '#dc2626', '#7c3aed']) {
  return {
    choices: labels.map((label, index) => ({
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      label,
      position: index,
      color: colors[index % colors.length],
    })),
  };
}

const F = {
  date: (name: string): PlanField => ({ name, type: 'date' }),
  money: (name: string): PlanField => ({ name, type: 'currency' }),
  number: (name: string): PlanField => ({ name, type: 'number' }),
  text: (name: string): PlanField => ({ name, type: 'singleLineText' }),
  long: (name: string): PlanField => ({ name, type: 'longText' }),
  email: (name = 'Email'): PlanField => ({ name, type: 'email' }),
  phone: (name = 'Phone'): PlanField => ({ name, type: 'phone' }),
  check: (name: string): PlanField => ({ name, type: 'checkbox' }),
  select: (name: string, labels: string[]): PlanField => ({ name, type: 'singleSelect', options: selectOptions(labels) }),
  link: (name: string, to: string): PlanField => ({ name, type: 'linkedRecord', linkTo: to }),
  rollup: (name: string, via: string, target: string, aggregation = 'sum'): PlanField => ({
    name, type: 'rollup', via, target, aggregation,
  }),
  count: (name: string, via: string): PlanField => ({ name, type: 'count', via }),
};

/** One domain template: match words (English + Roman Urdu) and the schema they unlock. */
interface Template {
  keywords: string[];
  baseName: string;
  tables: PlanTable[];
  widgets: PlanWidget[];
  label: string;
}

const TEMPLATES: Template[] = [
  {
    keywords: ['crm', 'sales', 'lead', 'deal', 'customer', 'client', 'pipeline'],
    label: 'a sales CRM',
    baseName: 'Sales CRM',
    tables: [
      {
        name: 'Contacts',
        fields: [F.email(), F.phone(), F.text('Company'), F.select('Status', ['Lead', 'Active', 'Lost'])],
        samples: [
          { Name: 'Ayesha Khan', Email: 'ayesha@corex.pk', Phone: '+92 300 1234567', Company: 'Corex', Status: 'Active' },
          { Name: 'Bilal Ahmed', Email: 'bilal@nova.io', Phone: '+92 321 5551234', Company: 'Nova', Status: 'Lead' },
          { Name: 'Sara Malik', Email: 'sara@zenith.com', Phone: '+92 333 7654321', Company: 'Zenith', Status: 'Active' },
        ],
      },
      {
        name: 'Deals',
        fields: [
          F.money('Amount'),
          F.select('Stage', ['Qualified', 'Proposal', 'Won', 'Lost']),
          F.date('Close Date'),
          F.link('Contact', 'Contacts'),
        ],
        samples: [
          { Name: 'Corex annual license', Amount: 250000, Stage: 'Proposal', 'Close Date': '2026-09-15', Contact: [0] },
          { Name: 'Nova starter pack', Amount: 60000, Stage: 'Qualified', 'Close Date': '2026-09-30', Contact: [1] },
          { Name: 'Zenith renewal', Amount: 180000, Stage: 'Won', 'Close Date': '2026-08-10', Contact: [2] },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Contacts', table: 'Contacts', agg: 'count' },
      { type: 'stat', title: 'Pipeline value', table: 'Deals', agg: 'sum', fieldName: 'Amount' },
      { type: 'chart', title: 'Deals by stage', table: 'Deals', groupFieldName: 'Stage' },
      { type: 'table', title: 'Recent deals', table: 'Deals' },
    ],
  },
  {
    keywords: ['hospital', 'clinic', 'patient', 'mareez', 'doctor', 'medical', 'dispensary'],
    label: 'a clinic / patients system',
    baseName: 'Clinic',
    tables: [
      {
        name: 'Patients',
        fields: [F.date('DOB'), F.phone(), F.select('Gender', ['Male', 'Female', 'Other']), F.long('Notes')],
        samples: [
          { Name: 'Imran Sheikh', DOB: '1985-03-12', Phone: '+92 300 1112223', Gender: 'Male', Notes: 'Diabetic, quarterly review' },
          { Name: 'Fatima Noor', DOB: '1992-11-02', Phone: '+92 321 9998887', Gender: 'Female', Notes: 'Allergy: penicillin' },
          { Name: 'Ahmed Raza', DOB: '1978-07-25', Phone: '+92 333 4445556', Gender: 'Male', Notes: '' },
        ],
      },
      {
        name: 'Appointments',
        fields: [
          F.date('Date'),
          F.select('Status', ['Scheduled', 'Completed', 'Cancelled']),
          F.money('Fee'),
          F.link('Patient', 'Patients'),
        ],
        samples: [
          { Name: 'Follow-up visit', Date: '2026-08-20', Status: 'Scheduled', Fee: 2000, Patient: [0] },
          { Name: 'First consultation', Date: '2026-08-19', Status: 'Completed', Fee: 3000, Patient: [1] },
          { Name: 'Lab review', Date: '2026-08-22', Status: 'Scheduled', Fee: 1500, Patient: [2] },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Patients', table: 'Patients', agg: 'count' },
      { type: 'stat', title: 'Appointment revenue', table: 'Appointments', agg: 'sum', fieldName: 'Fee' },
      { type: 'chart', title: 'Appointments by status', table: 'Appointments', groupFieldName: 'Status' },
      { type: 'table', title: 'Upcoming appointments', table: 'Appointments' },
    ],
  },
  {
    keywords: ['school', 'student', 'talib', 'class', 'college', 'academy', 'course', 'tuition'],
    label: 'a school / students system',
    baseName: 'School',
    tables: [
      {
        name: 'Students',
        fields: [F.number('Roll No'), F.text('Class'), F.phone('Guardian Phone'), F.money('Fee'), F.check('Fee Paid')],
        samples: [
          { Name: 'Hassan Ali', 'Roll No': 101, Class: '9-A', 'Guardian Phone': '+92 300 111222', Fee: 5000, 'Fee Paid': true },
          { Name: 'Zainab Tariq', 'Roll No': 102, Class: '9-A', 'Guardian Phone': '+92 321 333444', Fee: 5000, 'Fee Paid': false },
          { Name: 'Usman Khalid', 'Roll No': 103, Class: '9-B', 'Guardian Phone': '+92 333 555666', Fee: 5000, 'Fee Paid': true },
        ],
      },
      {
        name: 'Teachers',
        fields: [F.text('Subject'), F.phone(), F.email()],
        samples: [
          { Name: 'Ms. Amna', Subject: 'Mathematics', Phone: '+92 300 777888', Email: 'amna@school.pk' },
          { Name: 'Mr. Farooq', Subject: 'Physics', Phone: '+92 321 999000', Email: 'farooq@school.pk' },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Students', table: 'Students', agg: 'count' },
      { type: 'stat', title: 'Fees collected', table: 'Students', agg: 'sum', fieldName: 'Fee' },
      { type: 'chart', title: 'Students by class', table: 'Students', groupFieldName: 'Class' },
      { type: 'table', title: 'Students', table: 'Students' },
    ],
  },
  {
    keywords: ['inventory', 'stock', 'product', 'warehouse', 'saman', 'order', 'shop', 'store', 'ecommerce'],
    label: 'an inventory & orders system',
    baseName: 'Inventory',
    tables: [
      {
        name: 'Products',
        fields: [F.text('SKU'), F.money('Price'), F.number('Stock Qty'), F.select('Category', ['General', 'Electronics', 'Supplies'])],
        samples: [
          { Name: 'USB Cable', SKU: 'SKU-001', Price: 450, 'Stock Qty': 120, Category: 'Electronics' },
          { Name: 'Notebook A5', SKU: 'SKU-002', Price: 250, 'Stock Qty': 300, Category: 'Supplies' },
          { Name: 'Desk Lamp', SKU: 'SKU-003', Price: 1800, 'Stock Qty': 45, Category: 'Electronics' },
        ],
      },
      {
        name: 'Orders',
        fields: [
          F.date('Order Date'),
          F.select('Status', ['Pending', 'Shipped', 'Delivered']),
          F.link('Products', 'Products'),
          F.rollup('Order Total', 'Products', 'Price', 'sum'),
          F.count('Item Count', 'Products'),
        ],
        samples: [
          { Name: 'ORD-1001', 'Order Date': '2026-08-15', Status: 'Shipped', Products: [0, 1] },
          { Name: 'ORD-1002', 'Order Date': '2026-08-16', Status: 'Pending', Products: [2] },
          { Name: 'ORD-1003', 'Order Date': '2026-08-17', Status: 'Delivered', Products: [0, 1, 2] },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Products', table: 'Products', agg: 'count' },
      { type: 'stat', title: 'Stock value', table: 'Products', agg: 'sum', fieldName: 'Price' },
      { type: 'chart', title: 'Orders by status', table: 'Orders', groupFieldName: 'Status' },
      { type: 'table', title: 'Recent orders', table: 'Orders' },
    ],
  },
  {
    keywords: ['project', 'task', 'kaam', 'todo', 'sprint', 'team'],
    label: 'a projects & tasks tracker',
    baseName: 'Projects',
    tables: [
      {
        name: 'Projects',
        fields: [F.date('Deadline'), F.select('Status', ['Planning', 'Active', 'Done']), F.money('Budget')],
        samples: [
          { Name: 'Website redesign', Deadline: '2026-10-01', Status: 'Active', Budget: 400000 },
          { Name: 'Mobile app v2', Deadline: '2026-12-15', Status: 'Planning', Budget: 900000 },
        ],
      },
      {
        name: 'Tasks',
        fields: [
          F.date('Due'),
          F.select('Priority', ['Low', 'Medium', 'High']),
          F.check('Done'),
          F.link('Project', 'Projects'),
        ],
        samples: [
          { Name: 'Design homepage', Due: '2026-08-25', Priority: 'High', Done: false, Project: [0] },
          { Name: 'Write API spec', Due: '2026-09-05', Priority: 'Medium', Done: false, Project: [1] },
          { Name: 'Set up analytics', Due: '2026-08-22', Priority: 'Low', Done: true, Project: [0] },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Open tasks', table: 'Tasks', agg: 'count' },
      { type: 'stat', title: 'Total budget', table: 'Projects', agg: 'sum', fieldName: 'Budget' },
      { type: 'chart', title: 'Tasks by priority', table: 'Tasks', groupFieldName: 'Priority' },
      { type: 'table', title: 'Tasks', table: 'Tasks' },
    ],
  },
  {
    keywords: ['employee', 'hr', 'staff', 'mulazim', 'payroll', 'attendance'],
    label: 'an HR / employees system',
    baseName: 'HR',
    tables: [
      {
        name: 'Employees',
        fields: [F.email(), F.phone(), F.money('Salary'), F.date('Join Date'), F.select('Department', ['Sales', 'Tech', 'Admin'])],
        samples: [
          { Name: 'Nadia Hussain', Email: 'nadia@company.pk', Phone: '+92 300 121212', Salary: 120000, 'Join Date': '2024-02-01', Department: 'Tech' },
          { Name: 'Omar Siddiqui', Email: 'omar@company.pk', Phone: '+92 321 343434', Salary: 95000, 'Join Date': '2025-06-15', Department: 'Sales' },
          { Name: 'Rabia Aslam', Email: 'rabia@company.pk', Phone: '+92 333 565656', Salary: 80000, 'Join Date': '2023-11-20', Department: 'Admin' },
        ],
      },
      {
        name: 'Leave Requests',
        fields: [F.date('From'), F.date('To'), F.select('Status', ['Pending', 'Approved', 'Rejected']), F.link('Employee', 'Employees')],
        samples: [
          { Name: 'Annual leave', From: '2026-09-01', To: '2026-09-05', Status: 'Pending', Employee: [0] },
          { Name: 'Sick leave', From: '2026-08-19', To: '2026-08-20', Status: 'Approved', Employee: [1] },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Employees', table: 'Employees', agg: 'count' },
      { type: 'stat', title: 'Monthly payroll', table: 'Employees', agg: 'sum', fieldName: 'Salary' },
      { type: 'chart', title: 'By department', table: 'Employees', groupFieldName: 'Department' },
      { type: 'table', title: 'Leave requests', table: 'Leave Requests' },
    ],
  },
  {
    keywords: ['invoice', 'billing', 'bill', 'payment', 'accounts'],
    label: 'an invoicing system',
    baseName: 'Billing',
    tables: [
      {
        name: 'Clients',
        fields: [F.email(), F.phone(), F.text('Company')],
        samples: [
          { Name: 'Corex Ltd', Email: 'billing@corex.pk', Phone: '+92 300 101010', Company: 'Corex' },
          { Name: 'Nova Inc', Email: 'ap@nova.io', Phone: '+92 321 202020', Company: 'Nova' },
        ],
      },
      {
        name: 'Invoices',
        fields: [
          F.date('Invoice Date'),
          F.money('Amount'),
          F.select('Status', ['Draft', 'Sent', 'Paid', 'Overdue']),
          F.link('Client', 'Clients'),
        ],
        samples: [
          { Name: 'INV-2026-001', 'Invoice Date': '2026-08-01', Amount: 150000, Status: 'Paid', Client: [0] },
          { Name: 'INV-2026-002', 'Invoice Date': '2026-08-10', Amount: 85000, Status: 'Sent', Client: [1] },
          { Name: 'INV-2026-003', 'Invoice Date': '2026-07-15', Amount: 60000, Status: 'Overdue', Client: [0] },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Invoices', table: 'Invoices', agg: 'count' },
      { type: 'stat', title: 'Invoiced amount', table: 'Invoices', agg: 'sum', fieldName: 'Amount' },
      { type: 'chart', title: 'Invoices by status', table: 'Invoices', groupFieldName: 'Status' },
      { type: 'table', title: 'Recent invoices', table: 'Invoices' },
    ],
  },
  {
    keywords: ['event', 'wedding', 'shadi', 'guest', 'party', 'conference'],
    label: 'an events & guests planner',
    baseName: 'Events',
    tables: [
      {
        name: 'Events',
        fields: [F.date('Date'), F.text('Venue'), F.money('Budget')],
        samples: [
          { Name: 'Annual dinner', Date: '2026-10-12', Venue: 'Pearl Hall', Budget: 500000 },
          { Name: 'Product launch', Date: '2026-09-05', Venue: 'Expo Center', Budget: 800000 },
        ],
      },
      {
        name: 'Guests',
        fields: [F.email(), F.phone(), F.select('RSVP', ['Invited', 'Confirmed', 'Declined']), F.link('Event', 'Events')],
        samples: [
          { Name: 'Ali Raza', Email: 'ali@mail.com', Phone: '+92 300 909090', RSVP: 'Confirmed', Event: [0] },
          { Name: 'Hina Shah', Email: 'hina@mail.com', Phone: '+92 321 808080', RSVP: 'Invited', Event: [0] },
          { Name: 'Kamran Iqbal', Email: 'kamran@mail.com', Phone: '+92 333 707070', RSVP: 'Confirmed', Event: [1] },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Guests', table: 'Guests', agg: 'count' },
      { type: 'stat', title: 'Total budget', table: 'Events', agg: 'sum', fieldName: 'Budget' },
      { type: 'chart', title: 'RSVP status', table: 'Guests', groupFieldName: 'RSVP' },
      { type: 'table', title: 'Events', table: 'Events' },
    ],
  },
  {
    keywords: ['property', 'real estate', 'plot', 'makan', 'rent', 'tenant'],
    label: 'a property / rentals system',
    baseName: 'Properties',
    tables: [
      {
        name: 'Properties',
        fields: [F.long('Address'), F.money('Rent'), F.select('Status', ['Vacant', 'Rented', 'Maintenance']), F.text('Type')],
        samples: [
          { Name: 'Flat 3B Gulberg', Address: 'Gulberg III, Lahore', Rent: 85000, Status: 'Rented', Type: 'Apartment' },
          { Name: 'House 12 DHA', Address: 'DHA Phase 5', Rent: 250000, Status: 'Vacant', Type: 'House' },
        ],
      },
      {
        name: 'Tenants',
        fields: [F.phone(), F.email(), F.date('Lease Start'), F.link('Property', 'Properties')],
        samples: [
          { Name: 'Salman Butt', Phone: '+92 300 616161', Email: 'salman@mail.com', 'Lease Start': '2026-01-01', Property: [0] },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Properties', table: 'Properties', agg: 'count' },
      { type: 'stat', title: 'Monthly rent roll', table: 'Properties', agg: 'sum', fieldName: 'Rent' },
      { type: 'chart', title: 'By status', table: 'Properties', groupFieldName: 'Status' },
      { type: 'table', title: 'Properties', table: 'Properties' },
    ],
  },
];

/** "Patients: Name, DOB, Phone" / "Orders (Date, Status)" — one custom table per line/segment. */
function parseExplicitTables(prompt: string): PlanTable[] {
  const tables: PlanTable[] = [];
  const segments = prompt.split(/\n|;/);
  for (const segment of segments) {
    const match = segment.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{1,40}?)\s*[:(]\s*(.{3,})\)?\s*$/);
    if (!match) continue;
    const name = match[1]!.trim();
    // Guard against sentences that merely contain a colon.
    if (name.split(' ').length > 4) continue;
    const fieldNames = match[2]!
      .replace(/\)/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 60)
      .slice(0, 20);
    if (fieldNames.length === 0) continue;
    tables.push({
      name,
      fields: fieldNames.map((fieldName) => ({ name: fieldName, ...guessFieldType(fieldName) })),
      samples: [],
    });
  }
  return tables;
}

export function generatePlan(prompt: string): Plan {
  const lower = prompt.toLowerCase();

  const explicit = parseExplicitTables(prompt);
  const template = TEMPLATES.find((t) => t.keywords.some((k) => lower.includes(k)));

  if (explicit.length > 0) {
    // The user spelled out the schema — that IS the plan; a matching template only lends its
    // dashboard idea for the first table.
    const first = explicit[0]!;
    const numeric = first.fields.find((f) => f.type === 'currency' || f.type === 'number');
    const select = first.fields.find((f) => f.type === 'singleSelect');
    const widgets: PlanWidget[] = [
      { type: 'stat', title: `${first.name} count`, table: first.name, agg: 'count' },
      ...(numeric ? [{ type: 'stat', title: `Total ${numeric.name}`, table: first.name, agg: 'sum', fieldName: numeric.name } as PlanWidget] : []),
      ...(select ? [{ type: 'chart', title: `By ${select.name}`, table: first.name, groupFieldName: select.name } as PlanWidget] : []),
      { type: 'table', title: `Recent ${first.name}`, table: first.name },
    ];
    return {
      baseName: template?.baseName ?? first.name,
      tables: explicit,
      widgets,
      summary:
        `You specified ${explicit.length} table${explicit.length > 1 ? 's' : ''} — ` +
        explicit.map((t) => `**${t.name}** (${t.fields.length + 1} fields)`).join(', ') +
        `. Field types were auto-detected from the names, and I will add a starter dashboard too.`,
    };
  }

  if (template) {
    return {
      baseName: template.baseName,
      tables: template.tables,
      widgets: template.widgets,
      summary:
        `Got it — I will build ${template.label}: ` +
        template.tables.map((t) => `**${t.name}** (${t.fields.length + 1} fields, ${t.samples.length} sample rows)`).join(' + ') +
        (template.tables.some((t) => t.fields.some((f) => f.type === 'linkedRecord'))
          ? '. The tables will be LINKED to each other'
          : '') +
        (template.tables.some((t) => t.fields.some((f) => f.type === 'rollup'))
          ? ', with rollup totals'
          : '') +
        ', plus a live dashboard (stats + chart) in Interfaces.',
    };
  }

  // Nothing matched: a sensible generic tracker seeded from the prompt's own words.
  const words = prompt.trim().split(/\s+/).filter((w) => /^[a-z]/i.test(w));
  const topic = words.slice(0, 3).join(' ') || 'Tracker';
  const name = topic.charAt(0).toUpperCase() + topic.slice(1, 30);
  return {
    baseName: name,
    tables: [
      {
        name: 'Items',
        fields: [
          F.select('Status', ['New', 'In progress', 'Done']),
          F.date('Date'),
          F.money('Amount'),
          F.long('Notes'),
        ],
        samples: [
          { Name: 'First item', Status: 'In progress', Date: '2026-08-18', Amount: 1000, Notes: 'Added by the AI builder' },
          { Name: 'Second item', Status: 'New', Date: '2026-08-19', Amount: 2500, Notes: '' },
        ],
      },
    ],
    widgets: [
      { type: 'stat', title: 'Items', table: 'Items', agg: 'count' },
      { type: 'stat', title: 'Total amount', table: 'Items', agg: 'sum', fieldName: 'Amount' },
      { type: 'chart', title: 'By status', table: 'Items', groupFieldName: 'Status' },
    ],
    summary:
      `I will build a general tracker for "${name}" — an Items table (Status, Date, Amount, Notes) and a dashboard. ` +
      `Tip: next time write it like "Patients: Name, DOB, Phone" to get exactly those tables. ` +
      `Or use keywords: CRM, clinic, school, inventory, projects, HR, invoices, events, property.`,
  };
}
