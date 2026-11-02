// @ts-strict-ignore
import { expectSnapshotWithDiffer } from '#mocks/util';
import * as db from '#server/db';

import { applyActions } from './transaction-rules';
import * as transfer from './transfer';

import { batchUpdateTransactions } from '.';

beforeEach(global.emptyDatabase());

function getAllTransactions() {
  return db.all<db.DbViewTransaction & { payee_name: db.DbPayee['name'] }>(
    `SELECT t.*, p.name as payee_name
       FROM v_transactions t
       LEFT JOIN payees p ON p.id = t.payee
       ORDER BY date DESC, amount DESC, id
     `,
  );
}

async function prepareDatabase() {
  await db.insertCategoryGroup({ id: 'group1', name: 'group1', is_income: 0 });
  await db.insertCategory({
    id: '1',
    name: 'cat1',
    cat_group: 'group1',
    is_income: 0,
  });
  await db.insertAccount({ id: 'one', name: 'one' });
  await db.insertAccount({ id: 'two', name: 'two' });
  await db.insertAccount({ id: 'three', name: 'three', offbudget: 1 });
  await db.insertPayee({ name: '', transfer_acct: 'one' });
  await db.insertPayee({ name: '', transfer_acct: 'two' });
  await db.insertPayee({
    name: '',
    transfer_acct: 'three',
  });
}

type Transaction = {
  account: string;
  amount: number;
  category?: string;
  date: string;
  id?: string;
  notes?: string;
  payee: string;
  transfer_id?: string;
  is_parent?: boolean;
  is_child?: boolean;
  parent_id?: string;
};

describe('Transfer', () => {
  test('transfers are properly inserted/updated/deleted', async () => {
    await prepareDatabase();

    let transaction: Transaction = {
      account: 'one',
      amount: 5000,
      payee: await db.insertPayee({ name: 'Non-transfer' }),
      date: '2017-01-01',
    };
    await db.insertTransaction(transaction);
    await transfer.onInsert(transaction);

    const differ = expectSnapshotWithDiffer(await getAllTransactions());

    const transferTwo = await db.first<db.DbPayee>(
      "SELECT * FROM payees WHERE transfer_acct = 'two'",
    );
    const transferThree = await db.first<db.DbPayee>(
      "SELECT * FROM payees WHERE transfer_acct = 'three'",
    );

    transaction = {
      account: 'one',
      amount: 5000,
      payee: transferTwo.id,
      date: '2017-01-01',
    };
    transaction.id = await db.insertTransaction(transaction);
    await transfer.onInsert(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    // Fill the transaction out
    transaction = await db.getTransaction(transaction.id);
    expect(transaction.transfer_id).toBeDefined();

    transaction = {
      ...transaction,
      date: '2017-01-05',
      notes: 'This is a note',
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    transaction = {
      ...transaction,
      payee: transferThree.id,
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    transaction = {
      ...transaction,
      payee: await db.insertPayee({ name: 'Not transferred anymore' }),
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    // Make sure it's not a linked transaction anymore
    transaction = await db.getTransaction(transaction.id);
    expect(transaction.transfer_id).toBeNull();

    // Re-transfer it
    transaction = {
      ...transaction,
      payee: transferTwo.id,
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    transaction = await db.getTransaction(transaction.id);
    expect(transaction.transfer_id).toBeDefined();

    await db.deleteTransaction(transaction);
    await transfer.onDelete(transaction);
    differ.expectToMatchDiff(await getAllTransactions());
  });

  test('transfers are properly de-categorized', async () => {
    await prepareDatabase();

    const transferTwo = await db.first<db.DbPayee>(
      "SELECT * FROM payees WHERE transfer_acct = 'two'",
    );
    const transferThree = await db.first<db.DbPayee>(
      "SELECT * FROM payees WHERE transfer_acct = 'three'",
    );

    let transaction: Transaction = {
      account: 'one',
      amount: 5000,
      payee: await db.insertPayee({ name: 'Non-transfer' }),
      date: '2017-01-01',
      category: '1',
    };
    transaction.id = await db.insertTransaction(transaction);
    await transfer.onInsert(transaction);

    const differ = expectSnapshotWithDiffer(await getAllTransactions());

    transaction = {
      ...(await db.getTransaction(transaction.id)),
      payee: transferThree.id,
      notes: 'hi',
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    transaction = {
      ...(await db.getTransaction(transaction.id)),
      payee: transferTwo.id,
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());
  });

  test('split transfers are retained on child transactions', async () => {
    // test: first add a txn having a transfer acct payee
    // then mark it as `is_parent` and add a child txn
    // the child txn should have a different transfer acct payee
    // and `is_child` set to true
    await prepareDatabase();

    const [transferOne, transferTwo] = await Promise.all([
      db.first<db.DbPayee>("SELECT * FROM payees WHERE transfer_acct = 'one'"),
      db.first<db.DbPayee>("SELECT * FROM payees WHERE transfer_acct = 'two'"),
    ]);

    let parent: Transaction = {
      account: 'one',
      amount: 5000,
      payee: transferTwo.id,
      date: '2017-01-01',
    };
    parent.id = await db.insertTransaction(parent);
    await transfer.onInsert(parent);
    parent = await db.getTransaction(parent.id);

    const differ = expectSnapshotWithDiffer(await getAllTransactions());

    // mark the txn as parent
    await db.updateTransaction({ id: parent.id, is_parent: true });
    await transfer.onUpdate(parent);
    differ.expectToMatchDiff(await getAllTransactions());

    // add a child txn
    let child: Transaction = {
      account: 'one',
      amount: 2000,
      payee: transferOne.id,
      date: '2017-01-01',
      is_child: true,
      parent_id: parent.id,
    };
    child.id = await db.insertTransaction(child);
    await transfer.onInsert(child);
    differ.expectToMatchDiff(await getAllTransactions());

    // ensure that the child txn has the correct transfer acct payee
    child = await db.getTransaction(child.id);
    expect(child.transfer_id).not.toBe(parent.transfer_id);
    expect(child.payee).toBe(transferOne.id);
  });

  describe('linking existing transactions', () => {
    async function getTransferPayees() {
      const [transferOne, transferTwo] = await Promise.all([
        db.first<db.DbPayee>(
          "SELECT * FROM payees WHERE transfer_acct = 'one'",
        ),
        db.first<db.DbPayee>(
          "SELECT * FROM payees WHERE transfer_acct = 'two'",
        ),
      ]);
      return { transferOne, transferTwo };
    }

    async function getAccountTransactions(account: string) {
      return (await getAllTransactions()).filter(t => t.account === account);
    }

    test('applying a transfer payee links the matching transaction in the other account', async () => {
      await prepareDatabase();
      const { transferOne, transferTwo } = await getTransferPayees();

      const inOne = await db.insertTransaction({
        account: 'one',
        amount: 2500,
        payee: await db.insertPayee({ name: 'b' }),
        date: '2017-01-01',
      });
      const inTwo = await db.insertTransaction({
        account: 'two',
        amount: -2500,
        payee: await db.insertPayee({ name: 'a' }),
        date: '2017-01-01',
      });

      await applyActions(
        [await db.getTransaction(inTwo)],
        [{ op: 'set', field: 'payee', value: transferOne.id }],
      );

      const one = await getAccountTransactions('one');
      const two = await getAccountTransactions('two');
      expect(one).toHaveLength(1);
      expect(two).toHaveLength(1);
      expect(one[0]).toMatchObject({
        id: inOne,
        amount: 2500,
        payee: transferTwo.id,
        transfer_id: inTwo,
      });
      expect(two[0]).toMatchObject({
        id: inTwo,
        amount: -2500,
        payee: transferOne.id,
        transfer_id: inOne,
      });
    });

    test('updating both sides in one batch links them to each other', async () => {
      await prepareDatabase();
      const { transferOne, transferTwo } = await getTransferPayees();

      const inOne = await db.insertTransaction({
        account: 'one',
        amount: 2500,
        payee: await db.insertPayee({ name: 'b' }),
        date: '2017-01-01',
      });
      const inTwo = await db.insertTransaction({
        account: 'two',
        amount: -2500,
        payee: await db.insertPayee({ name: 'a' }),
        date: '2017-01-01',
      });

      await batchUpdateTransactions({
        updated: [
          { id: inOne, payee: transferTwo.id },
          { id: inTwo, payee: transferOne.id },
        ],
      });

      const one = await getAccountTransactions('one');
      const two = await getAccountTransactions('two');
      expect(one).toHaveLength(1);
      expect(two).toHaveLength(1);
      expect(one[0]).toMatchObject({ id: inOne, transfer_id: inTwo });
      expect(two[0]).toMatchObject({ id: inTwo, transfer_id: inOne });
    });

    test('a new transfer is created when the match is ambiguous', async () => {
      await prepareDatabase();
      const { transferOne } = await getTransferPayees();

      for (let i = 0; i < 2; i++) {
        await db.insertTransaction({
          account: 'one',
          amount: 2500,
          payee: await db.insertPayee({ name: `b${i}` }),
          date: '2017-01-01',
        });
      }
      const inTwo = await db.insertTransaction({
        account: 'two',
        amount: -2500,
        payee: await db.insertPayee({ name: 'a' }),
        date: '2017-01-01',
      });

      await applyActions(
        [await db.getTransaction(inTwo)],
        [{ op: 'set', field: 'payee', value: transferOne.id }],
      );

      const one = await getAccountTransactions('one');
      expect(one).toHaveLength(3);
      expect(one.filter(t => t.transfer_id === inTwo)).toHaveLength(1);
      expect(one.filter(t => t.transfer_id == null)).toHaveLength(2);
    });

    test('a reconciled transaction is never linked', async () => {
      await prepareDatabase();
      const { transferOne } = await getTransferPayees();

      const inOne = await db.insertTransaction({
        account: 'one',
        amount: 2500,
        payee: await db.insertPayee({ name: 'b' }),
        date: '2017-01-01',
        reconciled: true,
      });
      const inTwo = await db.insertTransaction({
        account: 'two',
        amount: -2500,
        payee: await db.insertPayee({ name: 'a' }),
        date: '2017-01-01',
      });

      await applyActions(
        [await db.getTransaction(inTwo)],
        [{ op: 'set', field: 'payee', value: transferOne.id }],
      );

      const one = await getAccountTransactions('one');
      expect(one).toHaveLength(2);
      expect(one.find(t => t.id === inOne).transfer_id).toBeNull();
    });

    test('a candidate is linked at most once per batch', async () => {
      await prepareDatabase();
      const { transferTwo } = await getTransferPayees();

      const sources = [];
      for (let i = 0; i < 2; i++) {
        sources.push(
          await db.insertTransaction({
            account: 'one',
            amount: 2500,
            payee: await db.insertPayee({ name: `b${i}` }),
            date: '2017-01-01',
          }),
        );
      }
      const inTwo = await db.insertTransaction({
        account: 'two',
        amount: -2500,
        payee: await db.insertPayee({ name: 'a' }),
        date: '2017-01-01',
      });

      await applyActions(
        await Promise.all(sources.map(id => db.getTransaction(id))),
        [{ op: 'set', field: 'payee', value: transferTwo.id }],
      );

      const all = await getAllTransactions();
      const byId = new Map(all.map(t => [t.id, t]));
      for (const t of all) {
        expect(t.transfer_id).not.toBeNull();
        expect(byId.get(t.transfer_id).transfer_id).toBe(t.id);
      }
      const two = all.filter(t => t.account === 'two');
      expect(two).toHaveLength(2);
      expect(two.map(t => t.id)).toContain(inTwo);
      expect(two.reduce((sum, t) => sum + t.amount, 0)).toBe(-5000);
    });

    test('a transaction added in the same batch is never linked', async () => {
      await prepareDatabase();
      const { transferOne, transferTwo } = await getTransferPayees();

      const inOne = await db.insertTransaction({
        account: 'one',
        amount: 2500,
        payee: await db.insertPayee({ name: 'b' }),
        date: '2017-01-01',
      });

      await batchUpdateTransactions({
        added: [
          {
            id: 'added',
            account: 'two',
            amount: -2500,
            payee: transferOne.id,
            date: '2017-01-01',
          },
        ],
        updated: [{ id: inOne, payee: transferTwo.id }],
      });

      const all = await getAllTransactions();
      const byId = new Map(all.map(t => [t.id, t]));
      for (const t of all) {
        expect(t.transfer_id).not.toBeNull();
        expect(byId.get(t.transfer_id).transfer_id).toBe(t.id);
      }
      expect(all).toHaveLength(4);
    });

    test('a starting balance is never linked', async () => {
      await prepareDatabase();
      const { transferOne } = await getTransferPayees();

      const startingBalance = await db.insertTransaction({
        account: 'one',
        amount: 2500,
        payee: await db.insertPayee({ name: 'Starting Balance' }),
        date: '2017-01-01',
        starting_balance_flag: true,
      });
      const inTwo = await db.insertTransaction({
        account: 'two',
        amount: -2500,
        payee: await db.insertPayee({ name: 'a' }),
        date: '2017-01-01',
      });

      await applyActions(
        [await db.getTransaction(inTwo)],
        [{ op: 'set', field: 'payee', value: transferOne.id }],
      );

      const one = await getAccountTransactions('one');
      expect(one).toHaveLength(2);
      expect(one.find(t => t.id === startingBalance).transfer_id).toBeNull();
    });

    test('the schedule is copied to the linked transaction', async () => {
      await prepareDatabase();
      const { transferOne } = await getTransferPayees();

      const inOne = await db.insertTransaction({
        account: 'one',
        amount: 2500,
        payee: await db.insertPayee({ name: 'b' }),
        date: '2017-01-01',
      });
      const inTwo = await db.insertTransaction({
        account: 'two',
        amount: -2500,
        payee: await db.insertPayee({ name: 'a' }),
        date: '2017-01-01',
        schedule: 'schedule1',
      });

      await applyActions(
        [await db.getTransaction(inTwo)],
        [{ op: 'set', field: 'payee', value: transferOne.id }],
      );

      const linked = await db.getTransaction(inOne);
      expect(linked.transfer_id).toBe(inTwo);
      expect(linked.schedule).toBe('schedule1');
    });

    // Pins today's behaviour behind the known limitation below, so the
    // test.fails case can't pass just because linking broke
    test('payee removed -> linked counterpart is deleted (current behaviour)', async () => {
      await prepareDatabase();
      const { transferOne } = await getTransferPayees();

      const inOne = await db.insertTransaction({
        account: 'one',
        amount: 2500,
        payee: await db.insertPayee({ name: 'b' }),
        date: '2017-01-01',
      });
      const inTwo = await db.insertTransaction({
        account: 'two',
        amount: -2500,
        payee: await db.insertPayee({ name: 'a' }),
        date: '2017-01-01',
      });

      await applyActions(
        [await db.getTransaction(inTwo)],
        [{ op: 'set', field: 'payee', value: transferOne.id }],
      );
      expect((await db.getTransaction(inOne)).transfer_id).toBe(inTwo);

      await batchUpdateTransactions({
        updated: [{ id: inTwo, payee: await db.insertPayee({ name: 'c' }) }],
      });

      expect((await db.getTransaction(inTwo)).transfer_id).toBeNull();
      expect(await db.getTransaction(inOne)).toBeUndefined();
    });

    // Known limitation: nothing records whether the other side of a transfer
    // was created by Actual or already existed, so removeTransfer deletes it
    // either way. Turn this into a regular test once that is distinguishable.
    test.fails('payee removed -> pre-existing counterpart still exists', async () => {
      await prepareDatabase();
      const { transferOne } = await getTransferPayees();

      const inOne = await db.insertTransaction({
        account: 'one',
        amount: 2500,
        payee: await db.insertPayee({ name: 'b' }),
        date: '2017-01-01',
      });
      const inTwo = await db.insertTransaction({
        account: 'two',
        amount: -2500,
        payee: await db.insertPayee({ name: 'a' }),
        date: '2017-01-01',
      });

      await applyActions(
        [await db.getTransaction(inTwo)],
        [{ op: 'set', field: 'payee', value: transferOne.id }],
      );
      expect((await db.getTransaction(inOne)).transfer_id).toBe(inTwo);

      await batchUpdateTransactions({
        updated: [{ id: inTwo, payee: await db.insertPayee({ name: 'c' }) }],
      });

      expect(await db.getTransaction(inTwo)).toMatchObject({
        transfer_id: null,
      });
      expect(await db.getTransaction(inOne)).toBeDefined();
    });
  });
});
