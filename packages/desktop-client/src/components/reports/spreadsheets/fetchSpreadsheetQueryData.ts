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
  // `filters` was built from these conditions, one filter per condition.
  // If a condition failed to parse the two no longer line up, so leave the
  // filters as they are.
  const reportConditions = conditions.filter(cond => !cond.customName);
  if (
    !reportConditions.some(isTagCondition) ||
    reportConditions.length !== filters.length
  ) {
    return filters;
  }

  return Promise.all(
    filters.map(async (filter, index) => {
      if (!isTagCondition(reportConditions[index])) {
        return filter;
      }

      const tagFilter = filter as ObjectExpression;
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
