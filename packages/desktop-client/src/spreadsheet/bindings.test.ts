import * as queries from '#queries';

import * as bindings from './bindings';

describe('allAccountBalance', () => {
  it('sums the same transactions as the All Accounts page', () => {
    // The All Accounts page (accounts/Account.tsx) totals
    // queries.transactions() with no account id, which includes closed
    // accounts. The sidebar and mobile totals must agree with it.
    const pageFilters = queries.transactions().serialize().filterExpressions;
    const bindingFilters = bindings
      .allAccountBalance()
      .query.serialize().filterExpressions;

    expect(bindingFilters).toEqual(pageFilters);
  });

  it('sums the same split rows as the All Accounts page', () => {
    // The page queries with splits: 'grouped'. An aggregate on a grouped
    // query is collapsed to non-parent rows (is_parent = 0, see
    // loot-core aql/schema/executors.ts), which is exactly what 'inline'
    // (the default when no splits option is set) sums. 'all' would count
    // split parents and their children twice.
    expect(queries.transactions().serialize().tableOptions.splits).toBe(
      'grouped',
    );
    expect([undefined, 'inline']).toContain(
      bindings.allAccountBalance().query.serialize().tableOptions.splits,
    );
  });

  it('includes closed accounts that still have a balance', () => {
    const bindingFilters = bindings
      .allAccountBalance()
      .query.serialize().filterExpressions;

    expect(JSON.stringify(bindingFilters)).not.toContain('account.closed');
  });
});
