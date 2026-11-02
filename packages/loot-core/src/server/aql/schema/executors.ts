// @ts-strict-ignore

import { appendWhere, isAggregateQuery } from '#server/aql/compiler';
import type {
  CompilerState,
  OutputTypes,
  SqlPieces,
} from '#server/aql/compiler';
import { execQuery } from '#server/aql/exec';
import type { AqlQueryExecutor } from '#server/aql/exec';
import { convertOutputType } from '#server/aql/schema-helpers';
import * as db from '#server/db';
import { whereIn } from '#server/db/util';
import { q } from '#shared/query';
import type { QueryState } from '#shared/query';
import type { CategoryEntity } from '#types/models';
import { aqlQuery } from '..';

// Transactions executor

type SplitsOption = 'all' | 'inline' | 'none' | 'grouped';

function toGroup(parents, children, mapper = x => x) {
  return parents.reduce((list, parent) => {
    const childs = children.get(parent.id) || [];
    list.push({
      ...mapper(parent),
      subtransactions: childs.map(mapper),
    });
    return list;
  }, []);
}

// These two queries will return very different things:
//
// q('transactions').select({ $count: 'id' })
// q('transactions', { splits: "grouped" }).select({ $count: 'id' })
//
// The first will return the count of non-split and child
// transactions, and the second will return the count of all parent
// (or non-split) transactions

function execTransactions(
  compilerState: CompilerState,
  queryState: QueryState,
  sqlPieces: SqlPieces,
  params: (string | number)[],
  outputTypes: OutputTypes,
) {
  const tableOptions = queryState.tableOptions || {};
  const splitType = tableOptions.splits
    ? (tableOptions.splits as string)
    : 'inline';
  if (!isValidSplitsOption(splitType)) {
    throw new Error(`Invalid "splits" option for transactions: "${splitType}"`);
  }

  if (splitType === 'all' || splitType === 'inline' || splitType === 'none') {
    return execTransactionsBasic(
      compilerState,
      queryState,
      sqlPieces,
      params,
      splitType,
      outputTypes,
    );
  } else if (splitType === 'grouped') {
    return execTransactionsGrouped(
      compilerState,
      queryState,
      sqlPieces,
      params,
      outputTypes,
    );
  }
}

function _isUnhappy(filter) {
  // These fields can be filtered - all split transactions will
  // still be returned regardless
  for (const key of Object.keys(filter)) {
    if (key === '$or' || key === '$and') {
      if (filter[key] && _isUnhappy(filter[key])) {
        return true;
      }
    } else if (!(key.indexOf('account') === 0 || key === 'date')) {
      return true;
    }
  }
  return false;
}

export function isHappyPathQuery(queryState) {
  return queryState.filterExpressions.find(_isUnhappy) == null;
}

const NEGATED_OPS = ['$ne', '$notlike', '$notregexp'];

// REGEXP tests a NULL value as an empty string
function _regexpMatchesEmpty(regex) {
  if (typeof regex !== 'string') {
    // A pattern only known at run time, like a param, might
    return true;
  }
  try {
    return new RegExp(regex).test('');
  } catch {
    // An invalid pattern matches nothing in REGEXP
    return false;
  }
}

// Whether the filter has a condition that an empty value can match,
// like "is not" or "is nothing"
function _matchesEmpty(filter) {
  if (Array.isArray(filter)) {
    return filter.some(_matchesEmpty);
  }
  if (filter == null || typeof filter !== 'object' || filter instanceof Date) {
    return false;
  }
  return Object.entries(filter).some(([key, value]) => {
    if (NEGATED_OPS.includes(key)) {
      return true;
    }
    if (key === '$regexp') {
      return _regexpMatchesEmpty(value);
    }
    if (key === '$eq' || !key.startsWith('$')) {
      return value == null || _matchesEmpty(value);
    }
    return _matchesEmpty(value);
  });
}

async function execTransactionsGrouped(
  compilerState: CompilerState,
  queryState: QueryState,
  sqlPieces: SqlPieces,
  params: (string | number)[],
  outputTypes: OutputTypes,
) {
  const { withDead } = queryState;
  const whereDead = withDead ? '' : `AND ${sqlPieces.from}.tombstone = 0`;

  // Aggregate queries don't make sense for a grouped transactions
  // query. We never should include both parent and children
  // transactions as it would duplicate amounts and the final number
  // would never make sense. Instead, the matching children are
  // counted, and a matching split parent is counted only when none of
  // its children match. Split parents have no category and often no
  // notes, so they match any filter for an empty value, like "is not";
  // for those filters only the matching children are counted
  if (isAggregateQuery(queryState)) {
    const s = { ...sqlPieces };
    let aggParams = params;

    // We also want to exclude deleted transactions. Normally we
    // handle this manually down below, but now that we are doing a
    // normal query we want to rely on the view. Unfortunately, SQL
    // has already been generated so we can't easily change the view
    // name here; instead, we change it and map it back to the name
    // used elsewhere in the query. Ideally we'd improve this
    const from = withDead
      ? s.from
      : 'v_transactions_internal_alive v_transactions_internal';

    if (
      isHappyPathQuery(queryState) ||
      queryState.filterExpressions.some(_matchesEmpty)
    ) {
      // Either every parent matches along with all of its children, or
      // a parent may only match through an empty value, so we can
      // simply count the non-parents
      s.where = appendWhere(s.where, `${s.from}.is_parent = 0`);
    } else {
      // The subquery repeats the filter to find the parents with a
      // matching child, so the params are bound a second time. This is
      // only safe while every param sits in the where clause
      s.where = appendWhere(
        s.where,
        `(${s.from}.is_parent = 0 OR ${s.from}.id NOT IN (
          SELECT ${s.from}.parent_id FROM ${from} ${s.joins}
          ${appendWhere(s.where, `${s.from}.is_child = 1`)}
        ))`,
      );
      aggParams = [...params, ...params];
    }

    s.from = from;

    return execQuery(queryState, compilerState, s, aggParams, outputTypes);
  }

  let rows;
  let matched = null;

  if (isHappyPathQuery(queryState)) {
    // This is just an optimization - we can just filter out children
    // directly and only list parents
    const rowSql = `
      SELECT ${sqlPieces.from}.id as group_id
      FROM ${sqlPieces.from}
      ${sqlPieces.joins}
      ${appendWhere(sqlPieces.where, `is_child = 0 ${whereDead}`)}
      ${sqlPieces.orderBy}
      ${sqlPieces.limit != null ? `LIMIT ${sqlPieces.limit}` : ''}
      ${sqlPieces.offset != null ? `OFFSET ${sqlPieces.offset}` : ''}
    `;
    rows = await db.all<db.DbViewTransactionInternal>(rowSql, params);
  } else {
    // TODO: phew, what a doozy. write docs why it works this way
    const rowSql = `
      SELECT group_id, matched FROM (
        SELECT
          group_id,
          GROUP_CONCAT(id) as matched
          FROM (
            SELECT ${sqlPieces.from}.id, IFNULL(${sqlPieces.from}.parent_id, ${sqlPieces.from}.id) as group_id
            FROM ${sqlPieces.from}
            LEFT JOIN transactions _t2 ON ${sqlPieces.from}.is_child = 1 AND _t2.id = ${sqlPieces.from}.parent_id
            ${sqlPieces.joins}
            ${appendWhere(sqlPieces.where, `${sqlPieces.from}.tombstone = 0 AND IFNULL(_t2.tombstone, 0) = 0`)}
          )
        GROUP BY group_id
      )
      LEFT JOIN ${sqlPieces.from} ON ${sqlPieces.from}.id = group_id
      ${sqlPieces.joins}
      ${sqlPieces.orderBy}
      ${sqlPieces.limit != null ? `LIMIT ${sqlPieces.limit}` : ''}
      ${sqlPieces.offset != null ? `OFFSET ${sqlPieces.offset}` : ''}
    `;

    rows = await db.all<db.DbViewTransactionInternal>(rowSql, params);
    matched = new Set(
      [].concat.apply(
        [],
        rows.map(row => row.matched.split(',')),
      ),
    );
  }

  const where = whereIn(
    rows.map(row => row.group_id),
    `IFNULL(${sqlPieces.from}.parent_id, ${sqlPieces.from}.id)`,
  );
  const finalSql = `
    SELECT ${sqlPieces.select}, parent_id AS _parent_id FROM ${sqlPieces.from}
    ${sqlPieces.joins}
    WHERE ${where} ${whereDead}
    ${sqlPieces.orderBy}
  `;

  const allRows = await db.all<
    db.DbViewTransactionInternal & {
      _parent_id: db.DbViewTransactionInternal['parent_id'];
    }
  >(finalSql);

  // Group the parents and children up
  const { parents, children } = allRows.reduce(
    (acc, trans) => {
      const pid = trans._parent_id;
      delete trans._parent_id;

      if (pid == null) {
        acc.parents.push(trans);
      } else {
        const arr = acc.children.get(pid) || [];
        arr.push(trans);
        acc.children.set(pid, arr);
      }
      return acc;
    },
    { parents: [], children: new Map() },
  );

  const mapper = trans => {
    Object.keys(trans).forEach(name => {
      trans[name] = convertOutputType(trans[name], outputTypes.get(name));
    });

    if (matched && !matched.has(trans.id)) {
      trans._unmatched = true;
    }
    return trans;
  };

  return toGroup(parents, children, mapper);
}

async function execTransactionsBasic(
  compilerState: CompilerState,
  queryState: QueryState,
  sqlPieces: SqlPieces,
  params: (string | number)[],
  splitType: SplitsOption,
  outputTypes: OutputTypes,
) {
  const s = { ...sqlPieces };

  if (splitType !== 'all') {
    if (splitType === 'none') {
      s.where = appendWhere(s.where, `${s.from}.parent_id IS NULL`);
    } else {
      s.where = appendWhere(s.where, `${s.from}.is_parent = 0`);
    }
  }

  return execQuery(queryState, compilerState, s, params, outputTypes);
}

function isValidSplitsOption(splits: string): splits is SplitsOption {
  return ['all', 'inline', 'none', 'grouped'].includes(splits);
}

// Category groups executor

type CategoriesOption = 'all' | 'none';

async function execCategoryGroups(
  compilerState: CompilerState,
  queryState: QueryState,
  sqlPieces: SqlPieces,
  params: (string | number)[],
  outputTypes: OutputTypes,
) {
  const tableOptions = queryState.tableOptions || {};
  const categoriesOption = tableOptions.categories
    ? (tableOptions.categories as string)
    : 'all';
  if (!isValidCategoriesOption(categoriesOption)) {
    throw new Error(
      `Invalid "categories" option for category_groups: "${categoriesOption}"`,
    );
  }

  if (categoriesOption !== 'none') {
    return execCategoryGroupsWithCategories(
      compilerState,
      queryState,
      sqlPieces,
      params,
      categoriesOption,
      outputTypes,
    );
  }
  return execCategoryGroupsBasic(
    compilerState,
    queryState,
    sqlPieces,
    params,
    outputTypes,
  );
}

async function execCategoryGroupsWithCategories(
  compilerState: CompilerState,
  queryState: QueryState,
  sqlPieces: SqlPieces,
  params: (string | number)[],
  categoriesOption: CategoriesOption,
  outputTypes: OutputTypes,
) {
  const categoryGroups = await execCategoryGroupsBasic(
    compilerState,
    queryState,
    sqlPieces,
    params,
    outputTypes,
  );

  if (categoriesOption === 'none') {
    return categoryGroups;
  }

  const { data: categories }: { data: CategoryEntity[] } = await aqlQuery(
    q('categories')
      .filter({
        group: { $oneof: categoryGroups.map(cg => cg.id) },
      })
      .select('*'),
  );

  return categoryGroups.map(group => {
    const cats = categories.filter(cat => cat.group === group.id);
    return {
      ...group,
      categories: cats,
    };
  });
}

async function execCategoryGroupsBasic(
  compilerState: CompilerState,
  queryState: QueryState,
  sqlPieces: SqlPieces,
  params: (string | number)[],
  outputTypes: OutputTypes,
) {
  return execQuery(queryState, compilerState, sqlPieces, params, outputTypes);
}

function isValidCategoriesOption(
  categories: string,
): categories is CategoriesOption {
  return ['all', 'none'].includes(categories);
}

export const schemaExecutors: Record<string, AqlQueryExecutor> = {
  transactions: execTransactions,
  category_groups: execCategoryGroups,
};
