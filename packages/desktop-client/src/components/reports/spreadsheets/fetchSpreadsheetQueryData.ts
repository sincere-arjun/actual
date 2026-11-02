import { send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import type { ObjectExpression } from '@actual-app/core/shared/query';
import type {
  balanceTypeOpType,
  CategoryEntity,
  CategoryGroupEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import type { QueryDataEntity } from '#components/reports/ReportOptions';
import { aqlQuery } from '#queries/aqlQuery';

import { fetchBudgetData } from './budgetDataQuery';
import { makeQuery } from './makeQuery';

function isTagCondition(cond: RuleConditionEntity) {
  return cond.op === 'hasTags' || cond.op === 'hasAnyTag';
}

// Reports only count split children, so a tag written on a split parent's
// notes would never match. Let each tag filter also match the children of
// parents that carry the tag. Parents stay excluded, so nothing is counted
// twice.
async function includeTaggedSplitParents(
  conditions: RuleConditionEntity[],
  filters: unknown[],
) {
  const reportConditions = conditions.filter(cond => !cond.customName);
  if (!reportConditions.some(isTagCondition)) {
    return filters;
  }

  const [{ filters: otherFilters }, { filters: tagFilters }] =
    await Promise.all([
      send('make-filters-from-conditions', {
        conditions: reportConditions.filter(cond => !isTagCondition(cond)),
      }),
      send('make-filters-from-conditions', {
        conditions: reportConditions.filter(isTagCondition),
      }),
    ]);

  const parentTagFilters = await Promise.all(
    (tagFilters as ObjectExpression[]).map(async tagFilter => {
      const { data: parents } = await aqlQuery(
        q('transactions')
          .options({ splits: 'all' })
          .filter({ is_parent: true })
          .filter(tagFilter)
          .select('id'),
      );
      if (parents.length === 0) {
        return tagFilter;
      }
      return {
        $or: [
          tagFilter,
          {
            parent_id: { $oneof: parents.map(({ id }: { id: string }) => id) },
          },
        ],
      };
    }),
  );

  return [...otherFilters, ...parentTagFilters];
}

export async function fetchSpreadsheetQueryData({
  balanceTypeOp,
  startDate,
  endDate,
  interval,
  categories,
  categoryGroups,
  conditions,
  conditionsOp,
  conditionsOpKey,
  filters,
  budgetType,
  groupBy,
}: {
  balanceTypeOp: balanceTypeOpType | undefined;
  startDate: string;
  endDate: string;
  interval: string;
  categories: CategoryEntity[];
  categoryGroups: CategoryGroupEntity[];
  conditions: RuleConditionEntity[];
  conditionsOp: string;
  conditionsOpKey: string;
  filters: unknown[];
  budgetType?: SyncedPrefs['budgetType'];
  groupBy?: string;
}): Promise<{ assets: QueryDataEntity[]; debts: QueryDataEntity[] }> {
  if (balanceTypeOp === 'totalBudgeted') {
    return fetchBudgetData({
      startDate,
      endDate,
      interval,
      categories,
      categoryGroups,
      conditions,
      conditionsOp: conditionsOp === 'or' ? 'or' : 'and',
      budgetType,
    });
  }

  filters = await includeTaggedSplitParents(conditions, filters);

  const [assets, debts] = await Promise.all([
    aqlQuery(
      makeQuery(
        'assets',
        startDate,
        endDate,
        interval,
        conditionsOpKey,
        filters,
        groupBy,
      ),
    ).then(({ data }) => data),
    aqlQuery(
      makeQuery(
        'debts',
        startDate,
        endDate,
        interval,
        conditionsOpKey,
        filters,
        groupBy,
      ),
    ).then(({ data }) => data),
  ]);

  return { assets, debts };
}
