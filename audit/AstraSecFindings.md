# AstraSec Audit Findings

**Audit Date:** December 2024
**Auditor:** AstraSec

## Findings Summary

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| VN002 | Medium | Possible Lock of New Revenue for Deactivated Strategy | Resolved |
| VN004 | Low | Return Zero Pending Revenue for Deactivated Strategy | Acknowledged |
| Note1 | Info | Improved Input Validation in `_vote()` | Resolved |
| Note2 | Info | Redundant New Strategy Check in `addStrategy()` | Resolved |
| Note2-2 | Info | Redundant Distribute Amount Check | Acknowledged |

---

## VN002: Possible Lock of New Revenue for Deactivated Strategy

**Severity:** Medium

**Location:** `Voter.sol` - `_updateFor()` function

**Description:**
When a strategy is killed (deactivated), but users still have votes on it (weight > 0), new revenue that arrives would be calculated for that strategy but not credited anywhere - effectively locking funds in the contract.

```solidity
function _updateFor(address _strategy) internal {
    uint256 _supplied = strategy_Weight[_strategy];
    if (_supplied > 0) {
        // ...
        uint256 _delta = _index - _supplyIndex;
        if (_delta > 0) {
            uint256 _share = _supplied * _delta / 1e18;
            if (strategy_IsAlive[_strategy]) strategy_Claimable[_strategy] += _share;
            // If !isAlive, share is calculated but discarded - STUCK
        }
    }
}
```

**Resolution:**
Fixed by redirecting dead strategy revenue to treasury:

```solidity
if (_delta > 0) {
    uint256 _share = _supplied * _delta / 1e18;
    if (strategy_IsAlive[_strategy]) {
        strategy_Claimable[_strategy] += _share;
    } else {
        IERC20(revenueToken).safeTransfer(treasury, _share);
    }
}
```

**Status:** Resolved

---

## VN004: Return Zero Pending Revenue for Deactivated Strategy

**Severity:** Low

**Location:** `Voter.sol` - `getStrategyPendingRevenue()` function

**Description:**
The view function `getStrategyPendingRevenue()` (renamed from `strategy_PendingRevenue`) returns pending revenue for dead strategies, which could be misleading since that revenue actually goes to treasury.

```solidity
function getStrategyPendingRevenue(address strategy) external view returns (uint256) {
    uint256 _supplied = strategy_Weight[strategy];
    if (_supplied == 0) return 0;
    // Does not check strategy_IsAlive - returns value even for dead strategies
    uint256 _delta = index - strategy_SupplyIndex[strategy];
    if (_delta == 0) return 0;
    return _supplied * _delta / 1e18;
}
```

**Recommendation:**
Add check: `if (!strategy_IsAlive[strategy]) return 0;`

**Status:** Acknowledged - Kept as-is to allow monitoring of treasury-bound revenue from dead strategies

---

## Note1: Improved Input Validation in `_vote()`

**Severity:** Informational

**Location:** `Voter.sol` - `_vote()` function

**Description:**
If a user calls `vote()` with only dead or invalid strategies, `_totalVoteWeight` would be 0, potentially causing issues in the second loop's division or silently doing nothing.

**Resolution:**
Added validation after the first loop:

```solidity
// sum weights for valid strategies to normalize
for (uint256 i = 0; i < _strategyCnt; i++) {
    address _strategy = _strategyVote[i];
    if (strategy_IsValid[_strategy] && strategy_IsAlive[_strategy]) _totalVoteWeight += _weights[i];
}

if (_totalVoteWeight == 0) revert Voter__ZeroTotalWeight();  // Added

// allocate votes proportionally
// ...
```

**Status:** Resolved

---

## Note2: Redundant New Strategy Check in `addStrategy()`

**Severity:** Informational

**Location:** `Voter.sol` - `addStrategy()` function

**Description:**
The check `if (strategy_IsValid[strategy]) revert Voter__StrategyExists();` is redundant because `strategy` is a freshly deployed contract with a unique address that has never existed before.

```solidity
(strategy, bribeRouter) = IStrategyFactory(strategyFactory).createStrategy(...);

if (strategy_IsValid[strategy]) revert Voter__StrategyExists();  // Can never trigger
```

**Resolution:**
Removed the redundant check and the unused `Voter__StrategyExists` error.

**Status:** Resolved

---

## Note2-2: Redundant Distribute Amount Check

**Severity:** Informational

**Location:** `BribeRouter.sol` - `distribute()` function

**Description:**
The check `balance > IBribe(bribe).left(paymentToken)` in `distribute()` appears redundant since `notifyRewardAmount()` already has a similar check.

```solidity
// BribeRouter.sol
if (balance > 0 && balance > IBribe(bribe).left(paymentToken)) {  // Redundant?
    // ...
    IBribe(bribe).notifyRewardAmount(paymentToken, balance);
}

// Bribe.sol - notifyRewardAmount
if (reward < left(_rewardsToken)) revert Bribe__RewardSmallerThanLeft();  // Already checks
```

**Recommendation:**
Could remove the check in `distribute()` to save gas.

**Status:** Acknowledged - Kept as-is for the following reasons:
1. **Fail silently vs. revert**: Current check allows `distribute()` to skip silently rather than revert
2. **Gas on failure path**: Saves external call + revert gas when conditions aren't met
3. **Defense in depth**: Both layers protect themselves independently
