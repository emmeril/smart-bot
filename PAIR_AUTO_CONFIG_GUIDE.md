# Pair-Specific Automatic Configuration Guide

## Overview

The **Pair Auto-Config** system automatically calculates trading parameters (TP, SL, grid levels, etc.) based on the **pair you set** and the **grid order size**. You only need to set these two values, and everything else adjusts automatically.

## Quick Start

### Setting Up for a New Pair

1. **Set the Pair**: Choose your trading pair (e.g., `BTC/USDT`, `ETH/USDT`, `DOGE/USDT`)
2. **Set Grid Order Size**: Specify how much USD per grid order (e.g., `10` for $10 per order)
3. **Everything else auto-calculates** based on the pair's volatility category

That's it! No need to manually adjust TP, SL, grid levels, or risk parameters.

---

## Pair Categories

The system automatically detects which category your pair belongs to and adjusts parameters accordingly:

### 1. **MAJOR Pairs** (BTC, ETH, BNB, SOL)
- **Characteristics**: Low volatility, high liquidity, stable
- **Auto Parameters**:
  - Grid Levels: 15
  - Stop Loss: 2.0%
  - TP Multiplier: 1.8x ATR
  - Risk Level: Conservative
- **Best For**: Stable income, long hold strategies

**Example**: `BTC/USDT` with $50 order size
```
- TP Min: $0.25  (50 * 0.05 * 1.0)
- TP Max: $2.00  (50 * 0.04 * 1.0)  
- SL: 2.0% per position
- Grid Levels: 15
```

### 2. **MIDCAP Pairs** (ADA, XRP, MATIC, LINK, AVAX, etc.)
- **Characteristics**: Medium volatility, decent liquidity
- **Auto Parameters**:
  - Grid Levels: 12
  - Stop Loss: 2.8%
  - TP Multiplier: 1.9x ATR
  - Risk Level: Moderate
- **Best For**: Balanced trading, moderate growth

**Example**: `MATIC/USDT` with $20 order size
```
- TP Min: $0.10  (20 * 0.05 * 1.0)
- TP Max: $0.75  (20 * 0.0375 * 1.0)
- SL: 2.8% per position
- Grid Levels: 12
```

### 3. **SMALLCAP Pairs** (New alts, low-cap tokens)
- **Characteristics**: High volatility, lower liquidity, more risky
- **Auto Parameters**:
  - Grid Levels: 10
  - Stop Loss: 3.5%
  - TP Multiplier: 2.0x ATR
  - Risk Level: Aggressive
- **Best For**: Pump trades, high volatility plays

**Example**: `SHIB/USDT` with $10 order size
```
- TP Min: $0.05  (10 * 0.05 * 1.0)
- TP Max: $0.50  (10 * 0.05 * 1.0)
- SL: 3.5% per position
- Grid Levels: 10
```

---

## Auto-Calculated Parameters

When you set a pair and grid order size, these parameters are **automatically calculated**:

| Parameter | Calculation | Purpose |
|-----------|------------|---------|
| **gridLevels** | Profile-based (10-15) | Number of grid entry points |
| **gridRangePercent** | Profile-based (2.5%-5%) | Grid spread range |
| **gridTakeProfitLevels** | Profile-based (3-5) | Number of exit levels |
| **gridStopLossLevels** | Profile-based (2-3) | Number of SL tiers |
| **gridOrdersPerSide** | Profile-based (3-5) | Orders per direction |
| **targetProfitMinUsdt** | Order Size × Profile × 0.05 | Minimum TP amount |
| **targetProfitMaxUsdt** | Order Size × Profile × 0.04 | Maximum TP amount |
| **stopLossPercent** | Profile-based (2%-3.5%) | SL trigger level |
| **trailingEnabled** | Always ON | Tracks profit upwards |
| **riskRewardRatio** | Profile-based (1.2-1.5) | Risk/reward balance |

---

## How Order Size Affects Calculation

The **Grid Order Size** scales profit targets proportionally:

```
Base Target Profit = Order Size × Multiplier

Example:
- $10 order size × 0.05 = $0.50 min TP
- $20 order size × 0.05 = $1.00 min TP
- $50 order size × 0.05 = $2.50 min TP
```

**Larger orders = larger absolute profit targets**, but same risk percentage.

---

## Switching Between Pairs

### Scenario 1: Switch from BTC to ETH

**Before:**
```
Configuration:
- Pair: BTC/USDT
- Grid Order Size: $50
- Grid Levels: 15
- SL: 2.0%
```

**After (user changes pair to ETH/USDT):**
```
Configuration:
- Pair: ETH/USDT (CHANGED)
- Grid Order Size: $50 (stays same)
- Grid Levels: 15 (stays same - both are MAJOR)
- SL: 2.0% (stays same)
```

✅ **Result**: Parameters stay the same because both BTC and ETH are MAJOR pairs.

---

### Scenario 2: Switch from BTC to DOGE

**Before:**
```
Configuration:
- Pair: BTC/USDT (MAJOR)
- Grid Order Size: $50
- Grid Levels: 15
- SL: 2.0%
```

**After (user changes pair to DOGE/USDT):**
```
Configuration:
- Pair: DOGE/USDT (CHANGED)
- Grid Order Size: $50 (stays same)
- Grid Levels: 10 (AUTO-UPDATED - SMALLCAP uses 10)
- SL: 3.5% (AUTO-UPDATED - SMALLCAP uses 3.5%)
```

✅ **Result**: Parameters automatically adjust because DOGE is SMALLCAP (higher volatility).

---

## Dashboard Usage

### Setting Pair & Order Size Only

When updating configuration through the dashboard:

```json
{
  "pair": "BTC/USDT",           // SET THIS
  "gridOrderSizeUsdt": 25,       // SET THIS
  "gridLevels": "auto",          // Optional - will auto-calculate
  "gridStopLossPercent": "auto"  // Optional - will auto-calculate
}
```

**The system will:**
1. Detect that `BTC/USDT` is a MAJOR pair
2. Load MAJOR pair profile
3. Calculate all parameters based on $25 order size
4. Update TP, SL, grid levels, ATR multipliers, etc.

---

## Manual Overrides

You can still **override** specific parameters if needed:

```json
{
  "pair": "ETH/USDT",
  "gridOrderSizeUsdt": 30,
  "gridLevels": 20,              // Override - ignore auto (20 instead of 15)
  "customRiskLevel": 1.5         // Your custom multiplier
}
```

⚠️ **Note**: Once you manually override a parameter, it won't auto-update when pair changes. Clear overrides to re-enable auto-calculation.

---

## Risk Level Adjustments

The system adjusts profit targets based on **order size risk**:

```javascript
// Risk Adjustment Multiplier
orderSizeMultiplier = Math.max(1, gridOrderSize / 10)

// Example calculations:
- $10 order  → multiplier = 1.0    → TP: $0.05-$0.50
- $20 order  → multiplier = 2.0    → TP: $0.10-$1.00
- $50 order  → multiplier = 5.0    → TP: $0.25-$2.50
- $100 order → multiplier = 10.0   → TP: $0.50-$5.00
```

**Larger orders = proportionally larger TP targets** to match the increased exposure.

---

## Profile Details

### Major Profile (BTC, ETH, BNB, SOL)
```javascript
{
  gridLevels: 15,
  gridRangePercent: 2.5,
  gridTakeProfitLevels: 5,
  gridStopLossLevels: 3,
  gridOrdersPerSide: 5,
  stopLossAtrMultiplier: 1.4,
  stopLossMinPercent: 1.2,
  stopLossMaxPercent: 2.8,
  gridStopLossPercent: 2.0,
  riskRewardRatio: 1.5
}
```

### Midcap Profile (ADA, MATIC, LINK, AVAX)
```javascript
{
  gridLevels: 12,
  gridRangePercent: 3.5,
  gridTakeProfitLevels: 4,
  gridStopLossLevels: 3,
  gridOrdersPerSide: 4,
  stopLossAtrMultiplier: 1.5,
  stopLossMinPercent: 1.5,
  stopLossMaxPercent: 3.5,
  gridStopLossPercent: 2.8,
  riskRewardRatio: 1.35
}
```

### Smallcap Profile (Other pairs)
```javascript
{
  gridLevels: 10,
  gridRangePercent: 5.0,
  gridTakeProfitLevels: 3,
  gridStopLossLevels: 2,
  gridOrdersPerSide: 3,
  stopLossAtrMultiplier: 1.6,
  stopLossMinPercent: 2.0,
  stopLossMaxPercent: 4.5,
  gridStopLossPercent: 3.5,
  riskRewardRatio: 1.2
}
```

---

## Configuration Flow

```
User Sets Pair & Order Size
        ↓
System Detects Pair Category
        ↓
Load Appropriate Profile
        ↓
Calculate All Parameters
        ↓
Apply to Configuration
        ↓
Save to Database
        ↓
Next Trading Cycle Uses Auto-Calculated Values
```

---

## Adding Custom Pairs

To add a custom pair category, modify `PAIR_PROFILES`:

```javascript
const PAIR_PROFILES = {
    // ... existing profiles ...
    custom: {
        volatilityCategory: "medium",
        riskLevel: 1.0,
        gridLevels: 12,
        // ... other parameters
    }
};
```

Then update `detectPairCategory()` to recognize your custom pair:

```javascript
if (symbol.includes("YOUR_PAIR")) {
    return "custom";
}
```

---

## Monitoring Auto-Calculations

Check logs for auto-calculation events:

```
[CONFIG][INFO] Auto-calculated parameters for pair BTC/USDT
[CONFIG][INFO] Auto-calculating parameters for pair ETH/USDT with order size $25.00
```

---

## FAQ

**Q: Will parameters change if I change the pair?**  
A: Yes! If the new pair has a different volatility profile, parameters will auto-update immediately.

**Q: Can I use the same grid order size for all pairs?**  
A: Yes! The system scales profit targets proportionally, so $25/order works for BTC and DOGE (with different grid configs).

**Q: What if a pair isn't recognized?**  
A: The system defaults to SMALLCAP profile (most conservative for unknowns).

**Q: Can I disable auto-calculation?**  
A: Manual overrides disable auto-calc for that parameter. Set back to "auto" to re-enable.

**Q: How often does auto-calculation happen?**  
A: When pair or gridOrderSize changes. Otherwise, parameters stay stable.

---

## Examples

### Example 1: Conservative BTC Trading
```
Pair: BTC/USDT (Major)
Order Size: $50
Auto Result:
- 15 grid levels
- 2.0% stop loss
- TP: $0.25 - $2.00
- Trailing stop enabled
```

### Example 2: Aggressive Alt Trading
```
Pair: SHIB/USDT (Smallcap)
Order Size: $10
Auto Result:
- 10 grid levels
- 3.5% stop loss
- TP: $0.05 - $0.50
- Tighter risk management
```

### Example 3: Multi-Pair Strategy
```
BTC/USDT:   $50 order → 15 grids, 2.0% SL
ETH/USDT:   $40 order → 15 grids, 2.0% SL (same as BTC - both Major)
MATIC/USDT: $20 order → 12 grids, 2.8% SL (different profile)
DOGE/USDT:  $10 order → 10 grids, 3.5% SL (highest volatility)
```

---

## Version Info

- **Feature Added**: May 2026
- **System**: Smart Bot v1.0
- **Auto-Config Engine**: Pair Profile System
