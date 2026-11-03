// @ts-strict-ignore
import * as db from '#server/db';

import { runRules } from './transaction-rules';

async function getPayee(acct) {
  return db.first<db.DbPayee>('SELECT * FROM payees WHERE transfer_acct = ?', [
    acct,
  ]);
}

async function getTransferredAccount(transaction) {
  if (transaction.payee) {
    const result = await db.first<Pick<db.DbViewPayee, 'transfer_acct'>>(
      'SELECT transfer_acct FROM v_payees WHERE id = ?',
      [transaction.payee],
    );

    return result?.transfer_acct || null;
  }
  return null;
}

async function clearCategory(transaction, transferAcct) {
  const { offbudget: fromOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transaction.account]);
  const { offbudget: toOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transferAcct]);

  // If the transfer is between two on budget or two off budget accounts,
  // we should clear the category, because the category is not relevant
  if (fromOffBudget === toOffBudget) {
    await db.updateTransaction({ id: transaction.id, category: null });
    if (transaction.transfer_id) {
      await db.updateTransaction({
        id: transaction.transfer_id,
        category: null,
      });
    }
    return true;
  }
  return false;
}

export async function addTransfer(transaction, transferredAccount) {
  if (transaction.is_parent) {
    // For split transactions, we should create transfers using child transactions.
    // This is to ensure that the amounts received by the transferred account
    // reflects the amounts in the child transactions and not the parent transaction
    // amount which is the total amount.
    return null;
  }

  const { id: fromPayee } = await db.first<Pick<db.DbPayee, 'id'>>(
    'SELECT id FROM payees WHERE transfer_acct = ?',
    [transaction.account],
  );

  const transferTransaction = {
    account: transferredAccount,
    amount: -transaction.amount,
    payee: fromPayee,
    date: transaction.date,
    transfer_id: transaction.id,
    notes: transaction.notes || null,
    schedule: transaction.schedule,
    cleared: false,
  };
  const { notes, cleared, schedule } = await runRules(transferTransaction);
  const matchedSchedule = schedule ?? transaction.schedule;

  const id = await db.insertTransaction({
    ...transferTransaction,
    notes,
    cleared,
    schedule: matchedSchedule,
  });

  await db.updateTransaction({
    id: transaction.id,
    transfer_id: id,
    ...(matchedSchedule ? { schedule: matchedSchedule } : {}),
  });
  const categoryCleared = await clearCategory(transaction, transferredAccount);

  return {
    id: transaction.id,
    transfer_id: id,
    ...(categoryCleared ? { category: null } : {}),
  };
}

// When an existing transaction becomes a transfer, the other side may already
// exist in the destination account (e.g. both sides were entered or imported
// before a rule turned them into a transfer). Find it so we can link to it
// instead of creating a duplicate, but only when there is exactly one
// unambiguous candidate.
async function findExistingTransfer(transaction, transferredAccount) {
  if (transaction.is_child) {
    return null;
  }

  // Payee edits from the same batch are already written by now, so a
  // candidate that is becoming a transfer to some other account is skipped
  const candidates = await db.all<Pick<db.DbViewTransaction, 'id'>>(
    `SELECT id FROM v_transactions
       WHERE account = ? AND date = ? AND amount = ? AND id != ?
         AND (transfer_id IS NULL OR transfer_id = ?)
         AND is_parent = 0 AND is_child = 0 AND reconciled = 0
         AND starting_balance_flag = 0
         AND (payee IS NULL OR payee NOT IN (
           SELECT id FROM v_payees
             WHERE transfer_acct IS NOT NULL AND transfer_acct != ?
         ))`,
    [
      transferredAccount,
      db.toDateRepr(transaction.date),
      -transaction.amount,
      transaction.id,
      transaction.id,
      transaction.account,
    ],
  );
  return candidates.length === 1 ? candidates[0].id : null;
}

async function linkTransfer(transaction, transferId, transferredAccount) {
  const { id: fromPayee } = await getPayee(transaction.account);
  await db.updateTransaction({
    id: transferId,
    transfer_id: transaction.id,
    payee: fromPayee,
    ...(transaction.schedule ? { schedule: transaction.schedule } : {}),
  });
  await db.updateTransaction({ id: transaction.id, transfer_id: transferId });
  const categoryCleared = await clearCategory(
    { ...transaction, transfer_id: transferId },
    transferredAccount,
  );

  return {
    id: transaction.id,
    transfer_id: transferId,
    ...(categoryCleared ? { category: null } : {}),
  };
}

export async function removeTransfer(transaction) {
  const transferTrans = await db.getTransaction(transaction.transfer_id);

  // Perform operations on the transfer transaction only
  // if it is found. For example: when users delete both
  // (in & out) transfer transactions at the same time -
  // transfer transaction will not be found.
  if (transferTrans) {
    if (transferTrans.is_child) {
      // If it's a child transaction, we don't delete it because that
      // would invalidate the whole split transaction. Instead of turn
      // it into a normal transaction
      await db.updateTransaction({
        id: transaction.transfer_id,
        transfer_id: null,
        payee: null,
      });
    } else {
      await db.deleteTransaction({ id: transaction.transfer_id });
    }
  }
  await db.updateTransaction({ id: transaction.id, transfer_id: null });
  return { id: transaction.id, transfer_id: null };
}

export async function updateTransfer(transaction, transferredAccount) {
  const payee = await getPayee(transaction.account);

  await db.updateTransaction({
    id: transaction.transfer_id,
    account: transferredAccount,
    // Make sure to update the payee on the other side in case the
    // user moved this transaction into another account
    payee: payee.id,
    notes: transaction.notes,
    amount: -transaction.amount,
    schedule: transaction.schedule,
  });

  const categoryCleared = await clearCategory(transaction, transferredAccount);
  if (categoryCleared) {
    return { id: transaction.id, category: null };
  }
}

export async function onInsert(transaction) {
  const transferredAccount = await getTransferredAccount(transaction);

  if (transferredAccount) {
    return addTransfer(transaction, transferredAccount);
  }
}

export async function onDelete(transaction) {
  if (transaction.transfer_id) {
    await removeTransfer(transaction);
  }
}

// `claimed` holds the ids already paired up by other updates in the same
// batch. Writes in a batch only land when it ends, so the database can't tell
// us that another transaction has just linked to a candidate.
export async function onUpdate(transaction, claimed = new Set<string>()) {
  const transferredAccount = await getTransferredAccount(transaction);

  if (transaction.is_parent) {
    return removeTransfer(transaction);
  }

  if (transferredAccount && !transaction.transfer_id) {
    const existingId = await findExistingTransfer(
      transaction,
      transferredAccount,
    );

    // No awaits between checking and updating the claims
    if (claimed.has(transaction.id)) {
      // Another transaction in this batch already linked to this one
      return null;
    }
    claimed.add(transaction.id);
    if (existingId && !claimed.has(existingId)) {
      claimed.add(existingId);
      return linkTransfer(transaction, existingId, transferredAccount);
    }
    return addTransfer(transaction, transferredAccount);
  }

  if (!transferredAccount && transaction.transfer_id) {
    return removeTransfer(transaction);
  }

  if (transferredAccount && transaction.transfer_id) {
    return updateTransfer(transaction, transferredAccount);
  }
}
