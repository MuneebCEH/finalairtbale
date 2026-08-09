import { describe, expect, it } from 'vitest';

import {
  MAX_CASCADE_DEPTH,
  automationSchema,
  enteredCondition,
  isAllowedRequestTarget,
  isRetryable,
  matchesUpdateTrigger,
  resolveDeep,
  resolveTemplate,
  retryDelay,
  shouldRun,
} from '../src';

const TABLE = 'tbl_01KZEQTA3K80Y2PKNWMYT9BBXW';
const FIELD = 'fld_01KZEQTA3K80Y2PKNWMYT9BBXW';

describe('automation configuration', () => {
  it('accepts a trigger with steps', () => {
    const parsed = automationSchema.safeParse({
      name: 'Notify on new order',
      trigger: { type: 'recordCreated', tableId: TABLE },
      steps: [{ type: 'sendEmail', to: ['a@b.test'], subject: 'New', body: 'x' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an automation with no steps', () => {
    const parsed = automationSchema.safeParse({
      name: 'Does nothing',
      trigger: { type: 'recordCreated', tableId: TABLE },
      steps: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an unknown trigger or action type', () => {
    expect(
      automationSchema.safeParse({
        name: 'x',
        trigger: { type: 'telepathy', tableId: TABLE },
        steps: [{ type: 'sendEmail', to: ['a@b.test'], subject: 's', body: 'b' }],
      }).success,
    ).toBe(false);

    expect(
      automationSchema.safeParse({
        name: 'x',
        trigger: { type: 'recordCreated', tableId: TABLE },
        steps: [{ type: 'runShellCommand', command: 'rm -rf /' }],
      }).success,
    ).toBe(false);
  });
});

describe('shouldRun — loop prevention', () => {
  const automation = { id: 'atm_1', isEnabled: true };

  it('runs a fresh automation', () => {
    expect(shouldRun(automation, { chain: [], byAutomation: false })).toEqual({ run: true });
  });

  it('refuses an automation that has already run in this chain', () => {
    // The infinite loop: an automation that updates a record on a table whose updates trigger it
    // would otherwise write to the customer's data on every pass, forever.
    expect(shouldRun(automation, { chain: ['atm_1'], byAutomation: true })).toEqual({
      run: false,
      reason: 'selfTrigger',
    });
  });

  it('refuses a chain deeper than the cascade limit', () => {
    const chain = Array.from({ length: MAX_CASCADE_DEPTH }, (_, i) => `atm_other_${i}`);
    expect(shouldRun(automation, { chain, byAutomation: true })).toEqual({
      run: false,
      reason: 'tooDeep',
    });
  });

  it('allows a cascade within the limit', () => {
    expect(shouldRun(automation, { chain: ['atm_other'], byAutomation: true })).toEqual({ run: true });
  });

  it('refuses a disabled automation', () => {
    expect(shouldRun({ id: 'atm_1', isEnabled: false }, { chain: [], byAutomation: false })).toEqual({
      run: false,
      reason: 'disabled',
    });
  });

  it('reports the most specific reason when several apply', () => {
    // A disabled automation that would also self-trigger reports the loop, which is the thing
    // worth knowing.
    expect(
      shouldRun({ id: 'atm_1', isEnabled: false }, { chain: ['atm_1'], byAutomation: true }),
    ).toMatchObject({ reason: 'selfTrigger' });
  });
});

describe('matchesUpdateTrigger', () => {
  it('fires only for a watched field', () => {
    const trigger = { type: 'recordUpdated' as const, tableId: TABLE, watchFieldIds: [FIELD] };
    expect(matchesUpdateTrigger(trigger, [FIELD])).toBe(true);
    expect(matchesUpdateTrigger(trigger, ['fld_other'])).toBe(false);
  });

  it('fires for any field when none are named', () => {
    const trigger = { type: 'recordUpdated' as const, tableId: TABLE };
    expect(matchesUpdateTrigger(trigger, ['fld_anything'])).toBe(true);
    expect(matchesUpdateTrigger(trigger, [])).toBe(false);
  });
});

describe('enteredCondition', () => {
  const trigger = {
    type: 'recordMatchesCondition' as const,
    tableId: TABLE,
    conditionFieldId: FIELD,
    operator: 'is' as const,
    value: 'Done',
  };

  it('fires on the transition into matching', () => {
    expect(enteredCondition(trigger, { [FIELD]: 'Open' }, { [FIELD]: 'Done' })).toBe(true);
  });

  it('stays quiet while the record already matches', () => {
    // Otherwise "when status is Done" sends an email every time anybody edits a finished record.
    expect(enteredCondition(trigger, { [FIELD]: 'Done' }, { [FIELD]: 'Done' })).toBe(false);
  });

  it('stays quiet on the way out', () => {
    expect(enteredCondition(trigger, { [FIELD]: 'Done' }, { [FIELD]: 'Open' })).toBe(false);
  });

  it('handles emptiness as a condition', () => {
    const empty = { ...trigger, operator: 'isEmpty' as const };
    expect(enteredCondition(empty, { [FIELD]: 'x' }, {})).toBe(true);
    expect(enteredCondition(empty, {}, {})).toBe(false);
  });
});

describe('resolveTemplate', () => {
  const context = {
    trigger: { record: { id: 'rec_1', fields: { [FIELD]: 'Widget' } } },
    steps: [{ output: { total: 42 } }],
  };

  it('substitutes a path', () => {
    expect(resolveTemplate(`{{trigger.record.fields.${FIELD}}}`, context)).toBe('Widget');
  });

  it('accepts bracket and dot notation for indexes', () => {
    expect(resolveTemplate('{{steps[0].output.total}}', context)).toBe('42');
    expect(resolveTemplate('{{steps.0.output.total}}', context)).toBe('42');
  });

  it('substitutes several references in one string', () => {
    expect(resolveTemplate('{{trigger.record.id}} — {{steps[0].output.total}}', context)).toBe(
      'rec_1 — 42',
    );
  });

  it('renders a missing value as nothing, not as the template text', () => {
    // Otherwise a blank optional field posts "{{trigger.record.fields.fldX}}" into an email.
    expect(resolveTemplate('[{{trigger.record.fields.missing}}]', context)).toBe('[]');
  });

  it('refuses to walk into the prototype chain', () => {
    for (const path of ['constructor.prototype', '__proto__.polluted', 'trigger.__proto__']) {
      expect(resolveTemplate(`{{${path}}}`, context), path).toBe('');
    }
  });

  it('leaves text without references alone', () => {
    expect(resolveTemplate('no references here', context)).toBe('no references here');
  });

  it('resolves through nested structures', () => {
    const resolved = resolveDeep(
      { subject: '{{trigger.record.id}}', to: ['{{trigger.record.id}}@example.test'], count: 3 },
      context,
    );
    expect(resolved).toEqual({ subject: 'rec_1', to: ['rec_1@example.test'], count: 3 });
  });
});

describe('isRetryable', () => {
  it('retries server errors and explicit try-later responses', () => {
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 408 })).toBe(true);
  });

  it('does not retry a request that was simply wrong', () => {
    // Retrying a permanent failure delays the run, multiplies any side effect that did land, and
    // buries the real error under identical repeats.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryable({ status }), String(status)).toBe(false);
    }
  });

  it('retries transient network failures', () => {
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
  });

  it('does not retry an unrecognised error', () => {
    expect(isRetryable({ code: 'VALIDATION_FAILED' })).toBe(false);
    expect(isRetryable({})).toBe(false);
  });

  it('backs off and then gives up', () => {
    expect(retryDelay(1)).toBe(1_000);
    expect(retryDelay(2)).toBe(5_000);
    expect(retryDelay(3)).toBe(30_000);
    expect(retryDelay(4)).toBeNull();
  });
});

describe('isAllowedRequestTarget — SSRF', () => {
  it('allows an ordinary public address', () => {
    expect(isAllowedRequestTarget('https://api.example.com/hook')).toBe(true);
    expect(isAllowedRequestTarget('http://93.184.216.34/')).toBe(true);
  });

  it('refuses non-http protocols', () => {
    for (const url of ['file:///etc/passwd', 'gopher://x', 'ftp://x', 'javascript:alert(1)']) {
      expect(isAllowedRequestTarget(url), url).toBe(false);
    }
  });

  describe('refuses addresses inside the network', () => {
    const blocked = [
      'http://localhost/',
      'http://127.0.0.1/',
      'http://0.0.0.0/',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://service.internal/',
    ];

    for (const url of blocked) {
      it(url, () => {
        expect(isAllowedRequestTarget(url)).toBe(false);
      });
    }
  });

  it('refuses the cloud metadata endpoint', () => {
    // The single most valuable SSRF target: it hands out the instance's credentials.
    expect(isAllowedRequestTarget('http://169.254.169.254/latest/meta-data/')).toBe(false);
  });

  it('refuses a private address hidden in an IPv6 literal', () => {
    expect(isAllowedRequestTarget('http://[::ffff:169.254.169.254]/')).toBe(false);
    expect(isAllowedRequestTarget('http://[::ffff:127.0.0.1]/')).toBe(false);
  });

  it('checks the resolved address, not the hostname', () => {
    // A public name that resolves inward is the way around a hostname-only check.
    expect(isAllowedRequestTarget('https://totally-public.example.com/', '169.254.169.254')).toBe(false);
    expect(isAllowedRequestTarget('https://totally-public.example.com/', '93.184.216.34')).toBe(true);
  });

  it('refuses a malformed URL', () => {
    expect(isAllowedRequestTarget('not a url')).toBe(false);
  });
});
