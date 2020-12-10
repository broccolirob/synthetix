'use strict';

const { contract, web3 } = require('@nomiclabs/buidler');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { mockToken, setupAllContracts } = require('./setup');

// const { toUnit } = require('../utils')();

const { ensureOnlyExpectedMutativeFunctions } = require('./helpers');

const { toUnit, currentTime, fastForward } = require('../utils')();

const {
	constants: { ZERO_ADDRESS },
} = require('../..');

const BN = require('bn.js');

contract('BaseRewardEscrowV2', async accounts => {
	const WEEK = 604800;
	const YEAR = 31556926;

	const [, owner, feePoolAccount, account1, account2] = accounts;
	let baseRewardEscrowV2, synthetix, feePool;

	// Run once at beginning - snapshots will take care of resetting this before each test
	before(async () => {
		// Mock SNX
		({ token: synthetix } = await mockToken({ accounts, name: 'Synthetix', symbol: 'SNX' }));

		feePool = { address: feePoolAccount }; // mock contract with address

		({ BaseRewardEscrowV2: baseRewardEscrowV2 } = await setupAllContracts({
			accounts,
			contracts: ['BaseRewardEscrowV2'],
			mocks: {
				Synthetix: synthetix,
				FeePool: feePool,
			},
		}));
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: baseRewardEscrowV2.abi,
			ignoreParents: ['MixinResolver'],
			expected: [
				'appendVestingEntry',
				'startMergingWindow',
				'setAccountMergingDuration',
				'setMaxEscrowDuration',
				'nominateAccountToMerge',
				'mergeAccount',
				'migrateVestingSchedule',
				'migrateAccountEscrowBalances',
				'burnForMigration',
				'importVestingEntries',
				'createEscrowEntry',
				'vest',
			],
		});
	});

	describe('Constructor & Settings ', async () => {
		it('should set owner on contructor', async () => {
			const ownerAddress = await baseRewardEscrowV2.owner();
			assert.equal(ownerAddress, owner);
		});
		it('should set nextEntryId to 1', async () => {
			const nextEntryId = await baseRewardEscrowV2.nextEntryId();
			assert.equal(nextEntryId, 1);
		});
	});

	describe('There are no escrow entries initially', async () => {
		it('then numVestingEntries should return 0', async () => {
			assert.equal(0, await baseRewardEscrowV2.numVestingEntries(account1));
		});
		it('then numVestingEntries should return 0', async () => {
			assert.equal(0, await baseRewardEscrowV2.numVestingEntries(account1));
		});
		it('then totalEscrowedAccountBalance should return 0', async () => {
			assert.equal(0, await baseRewardEscrowV2.totalEscrowedAccountBalance(account1));
		});
		it('then totalVestedAccountBalance should return 0', async () => {
			assert.equal(0, await baseRewardEscrowV2.totalVestedAccountBalance(account1));
		});
	});

	describe('Creating vesting Schedule', async () => {
		describe('When appending vesting entry via feePool', async () => {
			let duration = YEAR;
			it('should revert appending a vesting entry from account1', async () => {
				// Transfer of SNX to the escrow must occur before creating an entry
				await synthetix.transfer(baseRewardEscrowV2.address, toUnit('1'), {
					from: owner,
				});

				await assert.revert(
					baseRewardEscrowV2.appendVestingEntry(account1, toUnit('1'), duration, {
						from: account1,
					}),
					'Only the FeePool can perform this action'
				);
			});
			it('should revert appending a vesting entry with a zero amount', async () => {
				// Transfer of SNX to the escrow must occur before creating an entry
				await synthetix.transfer(baseRewardEscrowV2.address, toUnit('1'), {
					from: owner,
				});

				await assert.revert(
					baseRewardEscrowV2.appendVestingEntry(account1, toUnit('0'), duration, {
						from: feePoolAccount,
					}),
					'Quantity cannot be zero'
				);
			});
			it('should revert appending a vesting entry if there is not enough SNX in the contracts balance', async () => {
				// Transfer of SNX to the escrow must occur before creating an entry
				await synthetix.transfer(baseRewardEscrowV2.address, toUnit('1'), {
					from: owner,
				});
				await assert.revert(
					baseRewardEscrowV2.appendVestingEntry(account1, toUnit('10'), duration, {
						from: feePoolAccount,
					}),
					'Must be enough balance in the contract to provide for the vesting entry'
				);
			});
			it('should revert appending a vesting entry if the duration is 0', async () => {
				duration = 0;

				// Transfer of SNX to the escrow must occur before creating an entry
				await synthetix.transfer(baseRewardEscrowV2.address, toUnit('10'), {
					from: owner,
				});
				await assert.revert(
					baseRewardEscrowV2.appendVestingEntry(account1, toUnit('10'), duration, {
						from: feePoolAccount,
					}),
					'Cannot escrow with 0 duration OR above MAX_DURATION'
				);
			});
			it('should revert appending a vesting entry if the duration is > MAX_DURATION', async () => {
				duration = (await baseRewardEscrowV2.MAX_DURATION()).add(toUnit(1));

				// Transfer of SNX to the escrow must occur before creating an entry
				await synthetix.transfer(baseRewardEscrowV2.address, toUnit('10'), {
					from: owner,
				});
				await assert.revert(
					baseRewardEscrowV2.appendVestingEntry(account1, toUnit('10'), duration, {
						from: feePoolAccount,
					}),
					'Cannot escrow with 0 duration OR above MAX_DURATION'
				);
			});
			describe('When successfully appending new escrow entry for account 1 with 10 SNX', () => {
				let entryID, nextEntryIdAfter, now, escrowAmount;
				beforeEach(async () => {
					duration = 1 * YEAR;

					entryID = await baseRewardEscrowV2.nextEntryId();

					now = await currentTime();

					escrowAmount = toUnit('10');
					// Transfer of SNX to the escrow must occur before creating an entry
					await synthetix.transfer(baseRewardEscrowV2.address, escrowAmount, {
						from: owner,
					});

					// Append vesting entry
					await baseRewardEscrowV2.appendVestingEntry(account1, escrowAmount, duration, {
						from: feePoolAccount,
					});

					nextEntryIdAfter = await baseRewardEscrowV2.nextEntryId();
				});
				it('Should return the vesting entry for account 1 and entryID', async () => {
					const vestingEntry = await baseRewardEscrowV2.getVestingEntry(account1, entryID);

					// endTime is 1 year after
					assert.isTrue(vestingEntry.endTime.gte(now + duration));

					// escrowAmount is 10
					assert.bnEqual(vestingEntry.escrowAmount, escrowAmount);

					// remainingAmount is 10
					assert.bnEqual(vestingEntry.remainingAmount, escrowAmount);

					// duration is 1 year
					assert.bnEqual(vestingEntry.duration, duration);

					// last vested timestamp is 0
					assert.bnEqual(vestingEntry.lastVested, new BN(0));
				});
				it('Should increment the nextEntryID', async () => {
					assert.bnEqual(nextEntryIdAfter, entryID.add(new BN(1)));
				});
				it('Account 1 should have balance of 10 SNX', async () => {
					assert.bnEqual(await baseRewardEscrowV2.balanceOf(account1), escrowAmount);
				});
				it('totalEscrowedBalance of the contract should be 10 SNX', async () => {
					assert.bnEqual(await baseRewardEscrowV2.totalEscrowedBalance(), escrowAmount);
				});
				it('Account1 should have totalVested Account Balance of 0', async () => {
					assert.bnEqual(await baseRewardEscrowV2.totalVestedAccountBalance(account1), new BN(0));
				});
				it('Account1 numVestingEntries is 1', async () => {
					assert.bnEqual(await baseRewardEscrowV2.numVestingEntries(account1), new BN(1));
				});
				describe('When 6 months has passed', () => {
					let vestingEntry, timeElapsed;
					beforeEach(async () => {
						timeElapsed = YEAR / 2;
						await fastForward(timeElapsed);
						vestingEntry = await baseRewardEscrowV2.getVestingEntry(account1, entryID);
					});
					it('last vested timestamp on entry is 0', async () => {
						assert.bnEqual(vestingEntry.lastVested, new BN(0));
					});
					it('remaining amount is same as the escrowAmount', async () => {
						assert.bnEqual(vestingEntry.remainingAmount, escrowAmount);
					});
					it('then the timeSinceLastVested the vesting entry is 1/2 year', async () => {
						const delta = await baseRewardEscrowV2.timeSinceLastVested(account1, entryID);
						assert.bnEqual(delta, vestingEntry.duration.div(new BN(2)));
					});
					it('then the vesting entry has 1/2 year * ratePerSecond claimable', async () => {
						const ratePerSecond = await baseRewardEscrowV2.ratePerSecond(account1, entryID);
						const expectedAmount = ratePerSecond.mul(new BN(timeElapsed));
						const claimable = await baseRewardEscrowV2.getVestingEntryClaimable(account1, entryID);
						assert.bnEqual(claimable, expectedAmount);
					});
				});
				describe('When one year has passed', () => {
					let vestingEntry;
					beforeEach(async () => {
						await fastForward(YEAR + 1);
						vestingEntry = await baseRewardEscrowV2.getVestingEntry(account1, entryID);
					});
					it('last vested timestamp on entry is 0', async () => {
						assert.bnEqual(vestingEntry.lastVested, new BN(0));
					});
					it('remaining amount is same as the escrowAmount', async () => {
						assert.bnEqual(vestingEntry.remainingAmount, escrowAmount);
					});
					it('then the timeSinceLastVested the vesting entry is the whole duration (1 year)', async () => {
						const delta = await baseRewardEscrowV2.timeSinceLastVested(account1, entryID);
						assert.bnEqual(delta, vestingEntry.duration);
					});
					it('then the vesting entry is fully claimable', async () => {
						const claimable = await baseRewardEscrowV2.getVestingEntryClaimable(account1, entryID);
						assert.bnEqual(claimable, escrowAmount);
					});
				});
			});
		});

		describe('Calculating the ratePerSecond emission of each entry', () => {
			beforeEach(async () => {
				// Transfer of SNX to the escrow must occur before creating an entry
				await synthetix.transfer(baseRewardEscrowV2.address, toUnit('31556926'), {
					from: owner,
				});
			});
			it('should be 1 SNX per second with entry of 31556926 SNX for 1 year (31556926 seconds) duration', async () => {
				const duration = 1 * YEAR;
				const expectedRatePerSecond = toUnit(1);

				const entryID = await baseRewardEscrowV2.nextEntryId();

				await baseRewardEscrowV2.appendVestingEntry(account1, toUnit('31556926'), duration, {
					from: feePoolAccount,
				});

				const ratePerSecond = await baseRewardEscrowV2.ratePerSecond(account1, entryID);

				assert.bnEqual(ratePerSecond, expectedRatePerSecond);
			});
			it('should be 0.5 SNX per second with entry of 15,778,463 SNX for 1 year (31556926 seconds) duration', async () => {
				const duration = 1 * YEAR;
				const expectedRatePerSecond = toUnit('0.5');

				const entryID = await baseRewardEscrowV2.nextEntryId();

				await baseRewardEscrowV2.appendVestingEntry(account1, toUnit('15778463'), duration, {
					from: feePoolAccount,
				});

				const ratePerSecond = await baseRewardEscrowV2.ratePerSecond(account1, entryID);

				assert.bnEqual(ratePerSecond, expectedRatePerSecond);
			});
			it('should be 0.25 SNX per second with entry of 7,889,231.5 SNX for 1 year (31556926 seconds) duration', async () => {
				const duration = 1 * YEAR;
				const expectedRatePerSecond = toUnit('0.25');

				const entryID = await baseRewardEscrowV2.nextEntryId();

				await baseRewardEscrowV2.appendVestingEntry(account1, toUnit('7889231.5'), duration, {
					from: feePoolAccount,
				});

				const ratePerSecond = await baseRewardEscrowV2.ratePerSecond(account1, entryID);

				assert.bnEqual(ratePerSecond, expectedRatePerSecond);
			});
			it('should return very small amount SNX per second with escrow amount of 31556927 wei for 1 year (31556926 seconds) duration', async () => {
				const duration = 1 * YEAR;
				const expectedRatePerSecond = web3.utils.toWei('1', 'wei');

				const entryID = await baseRewardEscrowV2.nextEntryId();

				await baseRewardEscrowV2.appendVestingEntry(account1, new BN(31556927), duration, {
					from: feePoolAccount,
				});

				const ratePerSecond = await baseRewardEscrowV2.ratePerSecond(account1, entryID);

				assert.bnEqual(ratePerSecond, expectedRatePerSecond);
			});
		});
	});

	describe('Creating a new escrow entry by approval', async () => {
		let duration, entryID;
		beforeEach(async () => {
			// approve rewardEscrow to spend SNX
			await synthetix.approve(baseRewardEscrowV2.address, toUnit('10'), { from: owner });

			duration = 1 * YEAR;
		});
		it('should revert if escrow quanity is equal or less than duration seconds, as will result in 0 ratePerSecond', async () => {
			await assert.revert(
				baseRewardEscrowV2.createEscrowEntry(account1, new BN(1000), duration, { from: owner }),
				'Escrow quantity less than duration'
			);
		});
		it('should revert when beneficiary is address zero', async () => {
			await assert.revert(
				baseRewardEscrowV2.createEscrowEntry(ZERO_ADDRESS, toUnit('1'), duration),
				'Cannot create escrow with address(0)'
			);
		});
		it('should revert when msg.sender has no approval to spend', async () => {
			await assert.revert(
				baseRewardEscrowV2.createEscrowEntry(ZERO_ADDRESS, toUnit('10'), duration, {
					from: account1,
				})
			);
		});
		describe('when successfully creating a new escrow entry for acount 1', () => {
			let vestingEntry, escrowAmount, now, nextEntryIdAfter;
			beforeEach(async () => {
				now = currentTime();
				escrowAmount = toUnit('10');

				const expectedEntryID = await baseRewardEscrowV2.nextEntryId();

				await baseRewardEscrowV2.createEscrowEntry(account1, escrowAmount, duration, {
					from: owner,
				});

				// retrieve the vesting entryID from account 1's list of account vesting entrys
				entryID = await baseRewardEscrowV2.accountVestingEntryIDs(account1, 0);

				assert.bnEqual(entryID, expectedEntryID);

				nextEntryIdAfter = await baseRewardEscrowV2.nextEntryId();
			});
			it('Should have created a new vesting entry for account 1', async () => {
				vestingEntry = await baseRewardEscrowV2.getVestingEntry(account1, entryID);

				// endTime is 1 year after
				assert.isTrue(vestingEntry.endTime.gte(now + duration));

				// escrowAmount is 10
				assert.bnEqual(vestingEntry.escrowAmount, escrowAmount);

				// remainingAmount is 10
				assert.bnEqual(vestingEntry.remainingAmount, escrowAmount);

				// duration is 1 year
				assert.bnEqual(vestingEntry.duration, duration);

				// last vested timestamp is 0
				assert.bnEqual(vestingEntry.lastVested, new BN(0));
			});
			it('Should increment the nextEntryID', async () => {
				assert.bnEqual(nextEntryIdAfter, entryID.add(new BN(1)));
			});
			it('totalEscrowedBalance of the contract should be 10 SNX', async () => {
				assert.bnEqual(await baseRewardEscrowV2.totalEscrowedBalance(), escrowAmount);
			});
			it('Account1 should have balance of 10 SNX', async () => {
				assert.bnEqual(await baseRewardEscrowV2.balanceOf(account1), escrowAmount);
			});
			it('Account1 should have totalVested Account Balance of 0', async () => {
				assert.bnEqual(await baseRewardEscrowV2.totalVestedAccountBalance(account1), new BN(0));
			});
			it('Account1 numVestingEntries is 1', async () => {
				assert.bnEqual(await baseRewardEscrowV2.numVestingEntries(account1), new BN(1));
			});
		});
	});

	describe('Vesting', () => {
		beforeEach(async () => {
			// Transfer of SNX to the escrow must occur before creating a vestinng entry
			await synthetix.transfer(baseRewardEscrowV2.address, toUnit('1000'), {
				from: owner,
			});
		});
		describe('Partial vesting of vesting entry after 6 months', () => {
			const duration = 1 * YEAR;

			let escrowAmount, timeElapsed, entryID, ratePerSecond, claimableSNX;
			beforeEach(async () => {
				escrowAmount = toUnit('1000');
				timeElapsed = 26 * WEEK;

				entryID = await baseRewardEscrowV2.nextEntryId();

				// Add a few vesting entries as the feepool address
				await baseRewardEscrowV2.appendVestingEntry(account1, escrowAmount, duration, {
					from: feePoolAccount,
				});

				// Need to go into the future to vest
				await fastForward(timeElapsed);

				ratePerSecond = await baseRewardEscrowV2.ratePerSecond(account1, entryID);
			});

			it('should vest 0 amount if entryID does not exist for user', async () => {
				const randomID = 200;
				await baseRewardEscrowV2.vest(account1, [randomID], { from: account1 });

				// Check user has no vested SNX
				assert.bnEqual(await synthetix.balanceOf(account1), toUnit('0'));

				// Check rewardEscrow does not have any SNX
				assert.bnEqual(await synthetix.balanceOf(baseRewardEscrowV2.address), escrowAmount);

				// Check total escrowedAccountBalance is unchanged
				const escrowedAccountBalance = await baseRewardEscrowV2.totalEscrowedAccountBalance(
					account1
				);
				assert.bnEqual(escrowedAccountBalance, escrowAmount);

				// Account should have 0 vested account balance
				const totalVestedAccountBalance = await baseRewardEscrowV2.totalVestedAccountBalance(
					account1
				);
				assert.bnEqual(totalVestedAccountBalance, toUnit('0'));
			});

			it('should have 50% of the vesting entry claimable', async () => {
				const expectedAmount = ratePerSecond.mul(new BN(timeElapsed));
				assert.bnEqual(
					await baseRewardEscrowV2.getVestingEntryClaimable(account1, entryID),
					expectedAmount
				);
			});

			it('should vest and transfer snx from contract to the user', async () => {
				claimableSNX = await baseRewardEscrowV2.getVestingEntryClaimable(account1, entryID);

				const escrowBalanceBefore = await synthetix.balanceOf(baseRewardEscrowV2.address);
				const totalEscrowedBalanceBefore = await baseRewardEscrowV2.totalEscrowedBalance();
				const accountEscrowedBalanceBefore = await baseRewardEscrowV2.totalEscrowedAccountBalance(
					account1
				);
				const accountTotalVestedBefore = await baseRewardEscrowV2.totalVestedAccountBalance(
					account1
				);

				// Vest
				await baseRewardEscrowV2.vest(account1, [entryID], { from: account1 });

				// Check user has the claimable vested SNX
				assert.bnGte(await synthetix.balanceOf(account1), claimableSNX);

				// Check rewardEscrow contract has less SNX
				assert.bnLte(await synthetix.balanceOf(baseRewardEscrowV2.address), escrowBalanceBefore);

				const vestingEntryAfter = await baseRewardEscrowV2.getVestingEntry(account1, entryID);

				const vestedAmount = vestingEntryAfter.escrowAmount.sub(vestingEntryAfter.remainingAmount);

				// contract total escrowed balance reduced by vested amount
				assert.bnEqual(
					await baseRewardEscrowV2.totalEscrowedBalance(),
					totalEscrowedBalanceBefore.sub(vestedAmount)
				);

				// user totalEscrowedAccountBalance is reduced
				assert.bnEqual(
					await baseRewardEscrowV2.totalEscrowedAccountBalance(account1),
					accountEscrowedBalanceBefore.sub(vestedAmount)
				);

				// user totalVestedAccountBalance is increased by vested amount
				assert.bnEqual(
					await baseRewardEscrowV2.totalVestedAccountBalance(account1),
					accountTotalVestedBefore.add(vestedAmount)
				);
			});

			it('should vest entryID 1 and update vesting entry', async () => {
				const now = await currentTime();

				// Vest
				await baseRewardEscrowV2.vest(account1, [entryID], { from: account1 });

				// Get vesting entry after
				const vestingEntry = await baseRewardEscrowV2.getVestingEntry(account1, entryID);

				// lastVested is currentTime + 1 second
				assert.bnEqual(vestingEntry.lastVested, now + 1);

				// escrowAmount remains the same
				assert.bnEqual(vestingEntry.escrowAmount, escrowAmount);
			});

			it('should vest and emit a Vest event', async () => {
				const vestTransaction = await baseRewardEscrowV2.vest(account1, [entryID], {
					from: account1,
				});

				const vestingEntryAfter = await baseRewardEscrowV2.getVestingEntry(account1, entryID);

				const vestedAmount = vestingEntryAfter.escrowAmount.sub(vestingEntryAfter.remainingAmount);

				// Vested(msg.sender, now, total);
				const vestedEvent = vestTransaction.logs.find(log => log.event === 'Vested');
				assert.eventEqual(vestedEvent, 'Vested', {
					beneficiary: account1,
					value: vestedAmount,
				});
			});
		});

		describe('When vesting after escrow ended', () => {
			let escrowAmount, duration, entryID;
			beforeEach(async () => {
				duration = 1 * YEAR;
				escrowAmount = toUnit('1000');

				entryID = await baseRewardEscrowV2.nextEntryId();

				// Add a few vesting entries as the feepool address
				await baseRewardEscrowV2.appendVestingEntry(account1, escrowAmount, duration, {
					from: feePoolAccount,
				});

				// fast forward to after escrow.endTime
				fastForward(duration + 10);
			});
			it('should vest and transfer all the snx to the user', async () => {
				await baseRewardEscrowV2.vest(account1, [entryID], {
					from: account1,
				});

				// Check user has all their vested SNX
				assert.bnEqual(await synthetix.balanceOf(account1), escrowAmount);

				// Check rewardEscrow does not have any SNX
				assert.bnEqual(await synthetix.balanceOf(baseRewardEscrowV2.address), toUnit('0'));
			});

			it('should vest and emit a Vest event', async () => {
				const vestTransaction = await baseRewardEscrowV2.vest(account1, [entryID], {
					from: account1,
				});

				// Vested(msg.sender, now, total);
				const vestedEvent = vestTransaction.logs.find(log => log.event === 'Vested');
				assert.eventEqual(vestedEvent, 'Vested', {
					beneficiary: account1,
					value: escrowAmount,
				});
			});

			it('should vest and update totalEscrowedAccountBalance', async () => {
				// This account should have an escrowedAccountBalance
				let escrowedAccountBalance = await baseRewardEscrowV2.totalEscrowedAccountBalance(account1);
				assert.bnEqual(escrowedAccountBalance, escrowAmount);

				// Vest
				await baseRewardEscrowV2.vest(account1, [entryID], {
					from: account1,
				});

				// This account should not have any amount escrowed
				escrowedAccountBalance = await baseRewardEscrowV2.totalEscrowedAccountBalance(account1);
				assert.bnEqual(escrowedAccountBalance, toUnit('0'));
			});

			it('should vest and update totalVestedAccountBalance', async () => {
				// This account should have zero totalVestedAccountBalance
				let totalVestedAccountBalance = await baseRewardEscrowV2.totalVestedAccountBalance(
					account1
				);
				assert.bnEqual(totalVestedAccountBalance, toUnit('0'));

				// Vest
				await baseRewardEscrowV2.vest(account1, [entryID], {
					from: account1,
				});

				// This account should have vested its whole amount
				totalVestedAccountBalance = await baseRewardEscrowV2.totalVestedAccountBalance(account1);
				assert.bnEqual(totalVestedAccountBalance, escrowAmount);
			});

			it('should vest and update totalEscrowedBalance', async () => {
				await baseRewardEscrowV2.vest(account1, [entryID], {
					from: account1,
				});

				// There should be no Escrowed balance left in the contract
				assert.bnEqual(await baseRewardEscrowV2.totalEscrowedBalance(), toUnit('0'));
			});
		});

		describe('Vesting multiple vesting entries', () => {
			const duration = 1 * YEAR;
			let escrowAmount1, escrowAmount2, escrowAmount3, entryID1, entryID2, entryID3;

			beforeEach(async () => {
				escrowAmount1 = toUnit('200');
				escrowAmount2 = toUnit('300');
				escrowAmount3 = toUnit('500');

				// Add a few vesting entries as the feepool address
				entryID1 = await baseRewardEscrowV2.nextEntryId();
				await baseRewardEscrowV2.appendVestingEntry(account1, escrowAmount1, duration, {
					from: feePoolAccount,
				});
				await fastForward(WEEK);

				entryID2 = await baseRewardEscrowV2.nextEntryId();
				await baseRewardEscrowV2.appendVestingEntry(account1, escrowAmount2, duration, {
					from: feePoolAccount,
				});
				await fastForward(WEEK);

				entryID3 = await baseRewardEscrowV2.nextEntryId();
				await baseRewardEscrowV2.appendVestingEntry(account1, escrowAmount3, duration, {
					from: feePoolAccount,
				});

				// Need to go into the future to vest all entries
				await fastForward(duration + WEEK * 3);
			});

			it('should have three vesting entries for the user', async () => {
				const numOfEntries = await baseRewardEscrowV2.numVestingEntries(account1);
				assert.bnEqual(numOfEntries, new BN(3));
			});

			describe('When another user vests all entries for account1', () => {
				beforeEach(async () => {
					await baseRewardEscrowV2.vest(account1, [entryID1, entryID2, entryID3], {
						from: account2,
					});
				});
				it('should vest all entries and transfer snx to the user', async () => {
					// Check user has all their vested SNX
					assert.bnEqual(await synthetix.balanceOf(account1), toUnit('1000'));

					// Check account2 has no SNX
					assert.bnEqual(await synthetix.balanceOf(account2), toUnit('0'));

					// Check rewardEscrow does not have any SNX
					assert.bnEqual(await synthetix.balanceOf(baseRewardEscrowV2.address), toUnit('0'));
				});
			});

			it('should vest all entries and transfer snx from contract to the user', async () => {
				await baseRewardEscrowV2.vest(account1, [entryID1, entryID2, entryID3], {
					from: account1,
				});

				// Check user has all their vested SNX
				assert.bnEqual(await synthetix.balanceOf(account1), toUnit('1000'));

				// Check rewardEscrow does not have any SNX
				assert.bnEqual(await synthetix.balanceOf(baseRewardEscrowV2.address), toUnit('0'));
			});

			it('should vest and emit a Vest event', async () => {
				const vestTx = await baseRewardEscrowV2.vest(account1, [entryID1, entryID2, entryID3], {
					from: account1,
				});

				// Vested(msg.sender, now, total);
				const vestedEvent = vestTx.logs.find(log => log.event === 'Vested');
				assert.eventEqual(vestedEvent, 'Vested', {
					beneficiary: account1,
					value: toUnit('1000'),
				});
			});

			it('should vest and update totalEscrowedAccountBalance', async () => {
				// This account should have an escrowedAccountBalance
				let escrowedAccountBalance = await baseRewardEscrowV2.totalEscrowedAccountBalance(account1);
				assert.bnEqual(escrowedAccountBalance, toUnit('1000'));

				// Vest
				await baseRewardEscrowV2.vest(account1, [entryID1, entryID2, entryID3], {
					from: account1,
				});

				// This account should not have any amount escrowed
				escrowedAccountBalance = await baseRewardEscrowV2.totalEscrowedAccountBalance(account1);
				assert.bnEqual(escrowedAccountBalance, toUnit('0'));
			});

			it('should vest and update totalVestedAccountBalance', async () => {
				// This account should have zero totalVestedAccountBalance
				let totalVestedAccountBalance = await baseRewardEscrowV2.totalVestedAccountBalance(
					account1
				);
				assert.bnEqual(totalVestedAccountBalance, toUnit('0'));

				// Vest
				await baseRewardEscrowV2.vest(account1, [entryID1, entryID2, entryID3], {
					from: account1,
				});

				// This account should have vested its whole amount
				totalVestedAccountBalance = await baseRewardEscrowV2.totalVestedAccountBalance(account1);
				assert.bnEqual(totalVestedAccountBalance, toUnit('1000'));
			});

			it('should vest and update totalEscrowedBalance', async () => {
				await baseRewardEscrowV2.vest(account1, [entryID1, entryID2, entryID3], {
					from: account1,
				});
				// There should be no Escrowed balance left in the contract
				assert.bnEqual(await baseRewardEscrowV2.totalEscrowedBalance(), toUnit('0'));
			});

			it('should vest all entries and ignore duplicate attempts to vest same entries again', async () => {
				// Vest attempt 1
				await baseRewardEscrowV2.vest(account1, [entryID1, entryID2, entryID3], {
					from: account1,
				});

				// Check user has all their vested SNX
				assert.bnEqual(await synthetix.balanceOf(account1), toUnit('1000'));

				// Check rewardEscrow does not have any SNX
				assert.bnEqual(await synthetix.balanceOf(baseRewardEscrowV2.address), toUnit('0'));

				// Vest attempt 2
				await baseRewardEscrowV2.vest(account1, [entryID1, entryID2, entryID3], {
					from: account1,
				});

				// Check user has same amount of SNX
				assert.bnEqual(await synthetix.balanceOf(account1), toUnit('1000'));

				// Check rewardEscrow does not have any SNX
				assert.bnEqual(await synthetix.balanceOf(baseRewardEscrowV2.address), toUnit('0'));
			});
		});
	});

	describe('Read Vesting Schedule', () => {
		beforeEach(async () => {});
	});

	describe('Account vesting schedule merging', () => {
		beforeEach(async () => {});
	});
});