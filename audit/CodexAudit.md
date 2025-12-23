# Liquid Signal Governance Security Review
Date: 2025-12-23
Commit: 4442c0d55e8f1ae750025b44d3191b5bbe0b78cf

## Executive Summary
- No critical, permissionless loss-of-funds issues found; highest risk is governance and configuration driven.
- GovernanceToken owner can change `voter`, allowing unstake with active votes and leaving unbacked voting power in the old Voter.
- Killing strategies leaves their weight in `totalWeight`, diluting allocations and redirecting revenue to treasury until voters reset.
- The system assumes standard ERC20 behavior; fee-on-transfer or rebasing tokens can break staking, revenue distribution, and bribe payouts.
- `notifyRevenue` rounds down; very small revenue amounts can be trapped in Voter indefinitely.
- BribeRouter cannot distribute balances below `DURATION`, potentially trapping small bribe amounts.
- Hardhat tests were executed (output shows 455 passing) but the CLI timed out; no static analysis tools were configured.

## Scope and Repository Mapping
Contracts:
- `contracts/GovernanceToken.sol` - non-transferable staking token with ERC20Votes
- `contracts/Voter.sol` - voting, strategy registry, revenue distribution
- `contracts/Strategy.sol` - dutch auction for revenue tokens
- `contracts/Bribe.sol` - per-strategy bribe distribution
- `contracts/RevenueRouter.sol` - revenue accumulator and notifier
- `contracts/StrategyFactory.sol` - deploys Strategy and BribeRouter
- `contracts/BribeFactory.sol` - deploys Bribe
- `contracts/BribeRouter.sol` - forwards auction payments into Bribe
- `contracts/Multicall.sol` - batching and read helpers
- `contracts/mocks/MockERC20.sol` - test token

Interfaces:
- `contracts/interfaces/IBribe.sol`
- `contracts/interfaces/IBribeFactory.sol`
- `contracts/interfaces/IBribeRouter.sol`
- `contracts/interfaces/IGovernanceToken.sol`
- `contracts/interfaces/IRevenueRouter.sol`
- `contracts/interfaces/IStrategy.sol`
- `contracts/interfaces/IStrategyFactory.sol`
- `contracts/interfaces/IVoter.sol`

External dependencies:
- OpenZeppelin: ERC20, ERC20Permit, ERC20Votes, IERC20Metadata, Ownable, ReentrancyGuard, SafeERC20, Math
- Hardhat, Ethers, Waffle (tests)
- Solmate is listed as a dependency but not used in contracts

## System Overview
Liquid Signal Governance is a voting-driven revenue routing system that converts protocol revenue into configurable outcomes via onchain strategies. Users stake an underlying ERC20 in `GovernanceToken` to mint a non-transferable voting token 1:1. The `Voter` contract holds vote weights for strategies, enforces one vote or reset per epoch, and maintains a global revenue index used to compute per-strategy claimable revenue. Governance votes directly decide how protocol revenue is allocated among strategies.

Revenue arrives in the `RevenueRouter` from external protocol sources. Anyone may call `flush` to approve and notify the `Voter`, which pulls the revenue token via `notifyRevenue`. If there are votes, `Voter` updates a global index and later computes each strategy share via `_updateFor`, allowing for batched distribution. If there are no votes, the revenue is forwarded to `treasury`.

Each `Strategy` is a dutch auction that sells its accrued revenue token balance for a payment token. The price decays linearly over `epochPeriod`, and each completed purchase resets the next epoch's `initPrice` based on the payment amount and `priceMultiplier` (bounded by `minInitPrice` and an absolute max). Payment is split between a `paymentReceiver` and a `BribeRouter` according to `Voter.bribeSplit`.

The `BribeRouter` holds the payment token share and calls `Bribe.notifyRewardAmount` to start a 7-day reward stream. The `Bribe` contract tracks virtual balances for voters who voted on that strategy, updated only by the `Voter` via `_deposit` and `_withdraw`. Voters can claim bribes directly from any bribe contract through `Voter.claimBribes`.

Trust boundaries and privileged roles:
- `Voter` owner can add/kill strategies, set `revenueSource`, change `bribeSplit`, and add bribe reward tokens.
- `GovernanceToken` owner can change `voter`, which controls the unstake lock.
- `paymentReceiver` and `treasury` are immutable and receive protocol funds.
- Factories are immutable; the system trusts their implementations.

Custody of funds:
- Staked underlying tokens are held in `GovernanceToken`.
- Revenue tokens are held in `RevenueRouter` and `Voter`, then sent to strategies.
- Strategies hold revenue tokens until bought; payment tokens are held briefly by strategies, then forwarded to `paymentReceiver` and `BribeRouter`.
- Bribe tokens are held in `Bribe` contracts.

Upgradeability and dependencies:
- No proxy or upgrade patterns are used.
- No oracle dependencies or cross-chain components are present.
- ERC20Votes adds offchain governance compatibility, but `Voter` uses raw balances, not delegated votes.

Call graph hotspots:
- `GovernanceToken.stake/unstake` for custody and vote locks.
- `Voter.vote/reset/notifyRevenue/distribute/_updateFor` for weight changes and revenue accounting.
- `Strategy.buy` for auctions and payment splitting.
- `Bribe.notifyRewardAmount/getReward` for reward accounting.
- `RevenueRouter.flush` and `BribeRouter.distribute` for moving funds between modules.

## Threat Model
Attacker capabilities:
- Permissionless callers can stake, vote, buy auctions, trigger revenue flushes, distribute revenue, and distribute bribes.
- Mempool visibility enables front-run and back-run around auctions and revenue distribution.
- Attackers can deploy helper contracts and send arbitrary ERC20 tokens to routers and strategies.

Privileged attacker model:
- Compromised or malicious `Voter`/`GovernanceToken` owner can reconfigure core parameters, add or kill strategies, and alter bribe settings.
- Treasury or payment receiver compromise results in direct loss of funds.

Assets at risk:
- Underlying tokens custodied in `GovernanceToken`.
- Revenue tokens held in `RevenueRouter` and `Voter`.
- Payment tokens and bribe rewards from `Strategy` and `Bribe`.
- Integrity of vote weights and revenue distribution fairness.

Key invariants:
- `totalWeight` equals the sum of all `strategy_Weight`.
- For each strategy, `Bribe.totalSupply` equals `Voter.strategy_Weight`.
- For each account, `account_UsedWeights` equals sum of `account_Strategy_Votes`.
- `strategy_SupplyIndex` is monotonic and never exceeds `index`.
- Total distributed revenue never exceeds total notified (modulo rounding).
- Unstake should be blocked while a user has active votes in the active `Voter`.

## Automated and Manual Review
Automated:
- Tests executed: `npx hardhat test` (timed out in CLI after ~333s, output shows 455 passing).
- No Slither/Echidna/Medusa configuration found in repo.

Manual:
- Line-by-line review of all contracts and interfaces.
- Focus on access control, reentrancy, accounting, auction math, bribes, and integration assumptions.

## Severity Rubric
- Critical: Permissionless loss of funds or governance takeover with minimal preconditions.
- High: Loss of funds or governance manipulation with limited preconditions, or high-impact privileged misuse.
- Medium: Meaningful economic loss, DoS, or governance disruption with realistic prerequisites.
- Low: Minor loss, operational risk, or edge-case behavior.
- Informational: Best practices, observability gaps, or low-risk design notes.

## Findings Summary
| ID | Title | Severity | Affected files | Short impact |
| --- | --- | --- | --- | --- |
| LSG-01 | GovernanceToken `voter` can be changed to bypass vote lock | High | `contracts/GovernanceToken.sol` | Unbacked votes and unstake bypass if owner changes voter |
| LSG-02 | Dead strategy weights dilute allocations until users reset | Medium | `contracts/Voter.sol` | Live strategies receive less revenue; dead share routes to treasury |
| LSG-03 | Fee-on-transfer or rebasing tokens break accounting | Medium | `contracts/GovernanceToken.sol`, `contracts/Voter.sol`, `contracts/Strategy.sol`, `contracts/Bribe.sol` | Insolvency or reverts during staking, distribution, or bribes |
| LSG-04 | Revenue dust can be trapped when ratio rounds to zero | Low | `contracts/Voter.sol` | Small revenues stuck in Voter indefinitely |
| LSG-05 | BribeRouter can lock small bribe balances | Low | `contracts/BribeRouter.sol`, `contracts/Bribe.sol` | Small bribe amounts stuck until threshold is met |

## Project Response
All findings are acknowledged or intended per client.

## Detailed Findings

### LSG-01: GovernanceToken `voter` can be changed to bypass vote lock
Severity: High
Impact: Active votes can remain in the old Voter while users unstake, creating unbacked voting power and skewed revenue distribution.
Likelihood: Medium (requires `GovernanceToken` owner action or compromise).
Affected components: GovernanceToken staking lock and voter tracking.
Root cause: `setVoter` is mutable and `unstake` only checks the current `voter` contract.

Detailed description:
`GovernanceToken.unstake` blocks unstaking only if `IVoter(voter).account_UsedWeights(msg.sender) != 0`. The owner can change `voter` at any time. If `voter` is set to a new contract or to `address(0)`, users can unstake even if they still have active votes recorded in the old Voter, leaving unbacked vote weight and claimable revenue in the old system.

Exploit scenario:
1. Users stake and vote in Voter A; `account_UsedWeights > 0`.
2. Owner sets `GovernanceToken.voter` to `address(0)` (or Voter B).
3. Users can now call `unstake` because the new voter reports zero weight.
4. Votes remain recorded in Voter A, still influencing revenue distribution.
5. Users can re-stake and vote again, effectively double-counting voting power across epochs or contracts.

Recommendations:
- Make `voter` immutable or set-once (only during initialization).
- Require `voter` to be non-zero and add a timelock or governance process for changes.
- If a change must be supported, add a migration flow that forces users to reset votes in the old Voter before allowing unstake or re-vote.

References:
- `contracts/GovernanceToken.sol:81`
- `contracts/GovernanceToken.sol:96`

### LSG-02: Dead strategy weights dilute allocations until users reset
Severity: Medium
Impact: Revenue distribution is diluted for live strategies, and dead strategy share is routed to treasury until voters reset.
Likelihood: Medium (occurs whenever a strategy is killed and voters delay reset).
Affected components: Strategy lifecycle and revenue accounting.
Root cause: `killStrategy` does not remove weight from `strategy_Weight` or `totalWeight`, and `_updateFor` continues to use dead weights.

Detailed description:
When a strategy is killed, it is marked `strategy_IsAlive = false`, but its weight remains in `strategy_Weight` and `totalWeight` until each voter resets. The global revenue index divides by `totalWeight`, so dead weight reduces the share of live strategies. `_updateFor` forwards the dead strategy share to `treasury`, which may differ from the intended allocation.

Exploit scenario:
1. A large voter allocates votes to strategy S.
2. Governance kills strategy S.
3. The voter never resets, leaving large dead weight in `totalWeight`.
4. Future revenue is split using the inflated `totalWeight`, reducing live strategy allocations.
5. The dead strategy share is redirected to treasury, potentially benefiting a compromised treasury or harming intended recipients.

Recommendations:
- Provide a mechanism to clear dead strategy weights without underflow, such as:
  - Track a separate `deadWeight` per strategy and subtract it from `totalWeight` while still allowing resets to reconcile.
  - Allow immediate reset for dead strategies without epoch delay.
  - Add a governance-triggered force reset after a grace period.

References:
- `contracts/Voter.sol:298`
- `contracts/Voter.sol:395`
- `contracts/Voter.sol:408`

### LSG-03: Fee-on-transfer or rebasing tokens break accounting
Severity: Medium
Impact: Under-collateralization or distribution reverts when transferred amounts differ from expected amounts.
Likelihood: Low to Medium (depends on token selection; WETH-like tokens are safe).
Affected components: Staking, revenue distribution, auctions, bribe rewards.
Root cause: Accounting assumes transfers are exact; no balance-delta checks are used.

Detailed description:
Several flows rely on nominal transfer amounts:
- `GovernanceToken.stake` mints based on `amount`, not actual received.
- `Voter.notifyRevenue` increases index using `amount`, not actual received.
- `Strategy.buy` splits `paymentAmount` without checking actual received.
- `Bribe.notifyRewardAmount` sets `rewardRate` based on `reward`, not actual received.
If any of these tokens charge transfer fees or rebase, internal accounting diverges from balances, causing insolvency or reverts on payouts.

Exploit scenario:
1. A strategy uses a fee-on-transfer payment token.
2. Buyer pays `paymentAmount`, but the Strategy receives less.
3. Strategy attempts to send `bribeAmount` and `receiverAmount` based on the nominal amount and reverts or underpays.
4. Auctions become unbuyable or bribe/receiver amounts are incorrect.

Recommendations:
- Restrict accepted tokens to standard ERC20 (no transfer fees, no rebasing).
- Use balance-before/after checks to compute actual received amounts and base minting/indexing/splits on actual deltas.
- Add explicit documentation and runtime checks to reject fee-on-transfer tokens.

References:
- `contracts/GovernanceToken.sol:71`
- `contracts/Voter.sol:183`
- `contracts/Strategy.sol:138`
- `contracts/Bribe.sol:132`

### LSG-04: Revenue dust can be trapped when ratio rounds to zero
Severity: Low
Impact: Very small revenue amounts can remain in Voter indefinitely.
Likelihood: Medium (anyone can send dust to RevenueRouter).
Affected components: Revenue distribution.
Root cause: Integer division truncation with no remainder tracking.

Detailed description:
`notifyRevenue` calculates `_ratio = amount * 1e18 / totalWeight` and only increments `index` if `_ratio > 0`. If `_ratio == 0`, the revenue tokens remain in Voter, but no strategy can ever claim them because the index does not change.

Exploit scenario:
1. Attacker sends a tiny amount of revenue token to `RevenueRouter`.
2. Attacker calls `flush`; `_ratio` becomes zero due to rounding.
3. Tokens stay in Voter and are never distributed.
4. Repeating this can accumulate unrecoverable dust.

Recommendations:
- Track and carry remainder (e.g., `unallocated += amount; _ratio = unallocated * 1e18 / totalWeight; unallocated %= totalWeight / 1e18`).
- Increase precision (e.g., 1e27) or add a sweep to treasury for dust balances.

References:
- `contracts/Voter.sol:190`
- `contracts/Voter.sol:191`

### LSG-05: BribeRouter can lock small bribe balances
Severity: Low
Impact: Small bribe amounts can remain stuck in BribeRouter if below `DURATION`.
Likelihood: Low to Medium depending on auction sizes.
Affected components: BribeRouter, Bribe distribution.
Root cause: `Bribe.notifyRewardAmount` reverts if `reward < DURATION`, while BribeRouter does not enforce a minimum threshold.

Detailed description:
`Bribe.notifyRewardAmount` requires `reward >= DURATION`. `BribeRouter.distribute` attempts to distribute any positive balance, which can revert if the balance is below this threshold. If the strategy is later killed or no more payments arrive, these balances can be permanently stuck.

Exploit scenario:
1. A strategy produces a small bribe balance (less than `DURATION` units).
2. A caller triggers `BribeRouter.distribute`, which reverts due to `reward < DURATION`.
3. If no further bribe payments occur, the balance never reaches the threshold and remains locked.

Recommendations:
- Add a minimum balance guard in `BribeRouter.distribute` (`balance >= DURATION`).
- Alternatively, allow smaller reward distributions by removing or lowering the `reward < DURATION` check in `Bribe`.
- Add a recovery function to sweep stuck balances to treasury or a rescue address.

References:
- `contracts/BribeRouter.sol:46`
- `contracts/BribeRouter.sol:55`
- `contracts/Bribe.sol:132`
- `contracts/Bribe.sol:133`

## Non-issues / False Positives Considered
- Flash loan voting attack claims in tests are not feasible as written because unstaking requires a reset in a later epoch (7-day lock).
- Vote weight changes after revenue notification are accounted for by `_updateFor` before weight changes, preventing retroactive capture.
- Auction price being a single lot price (not per-token) is consistent with the spec and appears intentional.
- `Strategy.buy` reentrancy is protected by `ReentrancyGuard`.

## Hardening Checklist
- Make `GovernanceToken.voter` immutable or set-once; use a timelock for any governance changes.
- Add a governance-controlled mechanism to clear dead strategy weights after a grace period.
- Document and enforce token compatibility constraints (no fee-on-transfer, no rebasing).
- Implement a dust remainder accumulator or sweep for `Voter` balance.
- Add a bribe recovery path or minimum threshold logic in `BribeRouter`.
- Validate `paymentReceiver` and token addresses on `addStrategy`.

## Tests to Add
- Property tests with fee-on-transfer mocks for staking, revenue distribution, and bribe payouts.
- Invariant tests around `setVoter` changes (ensuring no unbacked votes).
- Fuzz tests for `notifyRevenue` dust accumulation and remainder handling.
- BribeRouter distribution tests for balances just below `DURATION`.
- Governance tests for dead strategy weight decay and forced reset behavior.
