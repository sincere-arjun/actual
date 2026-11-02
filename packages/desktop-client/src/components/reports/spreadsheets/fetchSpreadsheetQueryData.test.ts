import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type { QueryState } from '@actual-app/core/shared/query';
import { makeTagAqlRegex } from '@actual-app/core/shared/tags';
import type { RuleConditionEntity } from '@actual-app/core/types/models';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchSpreadsheetQueryData } from './fetchSpreadsheetQueryData';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type Row = {
  id: string;
  is_parent: boolean;
  parent_id: string | null;
  notes: string | null;
  category: string | null;
  amount: number;
  date: string;
};

function transaction(row: Partial<Row> & Pick<Row, 'id' | 'amount'>): Row {
  return {
    is_parent: false,
    parent_id: null,
    notes: null,
    category: null,
    date: '2026-01-15',
    ...row,
  };
}

// The issue's example: a $50 tagged transaction plus a $1000 split whose
// parent carries the tag and whose children (750 + 250) do not.
function issueTransactions(childNotes: [string | null, string | null]) {
  return [
    transaction({ id: 'single', notes: '#test-tag', amount: -5000 }),
    transaction({
      id: 'parent',
      is_parent: true,
      notes: 'Plane Ticket #test-tag',
      amount: -100000,
    }),
    transaction({
      id: 'ticket',
      parent_id: 'parent',
      notes: childNotes[0],
      category: 'travel',
      amount: -75000,
    }),
    transaction({
      id: 'upgrade',
      parent_id: 'parent',
      notes: childNotes[1],
      category: 'fees',
      amount: -25000,
    }),
  ];
}

const TRANSFORMS: Record<string, (value: string) => string> = {
  $day: value => value,
  $month: value => value.slice(0, 7),
  $year: value => value.slice(0, 4),
};

function matchesField(value: unknown, expr: unknown): boolean {
  if (expr === null || typeof expr !== 'object') {
    return value === expr;
  }
  const { $transform, ...ops } = expr as Record<string, unknown>;
  const transformed =
    typeof $transform === 'string' && typeof value === 'string'
      ? TRANSFORMS[$transform](value)
      : value;

  return Object.entries(ops).every(([op, arg]) => {
    switch (op) {
      case '$eq':
        return transformed === arg;
      case '$regexp':
        return new RegExp(arg as string).test((transformed as string) ?? '');
      case '$oneof':
        return (arg as unknown[]).includes(transformed);
      case '$lt':
        return (transformed as number) < (arg as number);
      case '$gt':
        return (transformed as number) > (arg as number);
      case '$lte':
        return (transformed as string) <= (arg as string);
      case '$gte':
        return (transformed as string) >= (arg as string);
      default:
        throw new Error(`Unsupported operator in test: ${op}`);
    }
  });
}

function matches(row: Row, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expr]) => {
    if (key === '$and') {
      return (expr as Array<Record<string, unknown>>).every(f =>
        matches(row, f),
      );
    }
    if (key === '$or') {
      return (expr as Array<Record<string, unknown>>).some(f =>
        matches(row, f),
      );
    }
    return matchesField(row[key as keyof Row], expr);
  });
}

// Evaluates the transaction queries the report sends against an in-memory
// table, following the transactions executor's split handling: parents are
// excluded unless the query asks for `splits: 'all'`.
function serveTransactions(rows: Row[]) {
  initServer({
    'make-filters-from-conditions': async args => {
      const { conditions } = args as { conditions: RuleConditionEntity[] };
      return {
        filters: conditions.map(cond => {
          if (cond.op === 'hasTags') {
            return {
              $and: [
                { notes: { $regexp: makeTagAqlRegex(String(cond.value)) } },
              ],
            };
          }
          if (cond.op === 'is' && cond.field === 'category') {
            return { category: cond.value };
          }
          throw new Error(`Unsupported condition in test: ${cond.op}`);
        }),
      };
    },
    query: async args => {
      const query = args as QueryState;
      const splits = query.tableOptions?.splits ?? 'inline';
      const data = rows
        .filter(row => splits === 'all' || !row.is_parent)
        .filter(row =>
          query.filterExpressions.every(f =>
            matches(row, f as Record<string, unknown>),
          ),
        );
      return { data, dependencies: [] };
    },
  });
}

async function fetchDebtsTotal(conditions: RuleConditionEntity[]) {
  const { send } = await import('@actual-app/core/platform/client/connection');
  const { filters } = (await send('make-filters-from-conditions', {
    conditions,
  })) as { filters: unknown[] };

  const { debts } = await fetchSpreadsheetQueryData({
    balanceTypeOp: 'totalDebts',
    startDate: '2026-01',
    endDate: '2026-01',
    interval: 'Monthly',
    categories: [],
    categoryGroups: [],
    conditions,
    conditionsOp: 'and',
    conditionsOpKey: '$and',
    filters,
    groupBy: 'Category',
  });

  return debts.reduce((total, row) => total + row.amount, 0);
}

const hasTestTag: RuleConditionEntity = {
  field: 'notes',
  op: 'hasTags',
  value: '#test-tag',
};

afterEach(async () => {
  await clearServer();
});

describe('fetchSpreadsheetQueryData tag filters on split transactions', () => {
  it('includes the children of a split whose parent has the tag', async () => {
    serveTransactions(issueTransactions([null, null]));

    expect(await fetchDebtsTotal([hasTestTag])).toBe(-105000);
  });

  it('does not double count children tagged alongside their parent', async () => {
    serveTransactions(issueTransactions(['#test-tag', null]));

    expect(await fetchDebtsTotal([hasTestTag])).toBe(-105000);
  });

  it('includes only the tagged children when the parent is untagged', async () => {
    const rows = issueTransactions(['#test-tag', null]);
    rows[1].notes = 'Plane Ticket';
    serveTransactions(rows);

    expect(await fetchDebtsTotal([hasTestTag])).toBe(-80000);
  });

  it('applies other conditions to the children of a tagged parent', async () => {
    serveTransactions(issueTransactions([null, null]));

    expect(
      await fetchDebtsTotal([
        hasTestTag,
        { field: 'category', op: 'is', value: 'travel' },
      ]),
    ).toBe(-75000);
  });
});
