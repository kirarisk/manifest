# Fast CLOB Prototype

*Sub-50ms Orderbook Performance Challenging CEX Speed*

[![codecov](https://codecov.io/gh/CKS-Systems/manifest/graph/badge.svg?token=PJ3Y2BVMM8)](https://codecov.io/gh/CKS-Systems/manifest)
[![Code Review - Rust](https://github.com/CKS-Systems/manifest/actions/workflows/ci-code-review-rust.yml/badge.svg)](https://github.com/CKS-Systems/manifest/actions/workflows/ci-code-review-rust.yml)
[![Code Review - Typescript](https://github.com/CKS-Systems/manifest/actions/workflows/ci-code-review-ts.yml/badge.svg)](https://github.com/CKS-Systems/manifest/actions/workflows/ci-code-review-ts.yml)

A high-performance Central Limit Order Book (CLOB) prototype forked from [Manifest](https://github.com/CKS-Systems/manifest) and deployed on [MagicBlock's ephemeral rollups](https://magicblock.xyz/), achieving sub-50ms latency that rivals centralized exchange performance.

**Developed by [@kira_risk](https://twitter.com/kira_risk)**

## Quick Start

1. Clone and setup:
```bash
git clone https://github.com/kirarisk/manifest.git
cd manifest
```

2. Run the interactive CLI:
```bash
cd manifest-test
npm install
```

3. Configure your private key on line 63 of `manifest-test.ts`:
```typescript
const admin = Keypair.fromSecretKey(bs58.decode("your_private_key_here"));
```

4. Start the CLI:
```bash
ts-node manifest-test.ts
```

## Key Performance Features

### ⚡ Sub-50ms Latency
- Deployed on MagicBlock's ephemeral rollups for ultra-low latency
- Direct market state commits to ephemeral instances
- Minimal network overhead compared to mainnet Solana

### 🏗️ Advanced Data Structure
- **HyperTree**: 80-byte uniform node size enables efficient memory interleaving
- **Red-Black Trees**: O(log n) operations for bids, asks, and claimed seats
- **Capital Efficiency**: Global orders allow cross-market capital reuse

### 💡 Order Types
- **Limit Orders**: Standard resting orders
- **Immediate or Cancel (IOC)**: Take-only orders
- **Post Only**: Fail if crossing the book
- **Global Orders**: Capital-efficient cross-market orders
- **Reverse Orders**: AMM-like behavior with automatic side switching

### 🔧 Technical Architecture

```
Market Account Layout:
┌─────────────────────────────────────────────────────────────────────┐
│  Header (Fixed)         │           Dynamic Data                     │
├─────────────────────────┼───────────────────────────────────────────┤
│ BaseMint, QuoteMint,    │ Bid │ Ask │ FreeList │ Seat │ Bid │ Ask    │
│ BidsRoot, AsksRoot...   │     │     │  Nodes   │      │     │        │
└─────────────────────────┴───────────────────────────────────────────┘
```

- **Feeless Trading**: No trading fees forever
- **Atomic Lot Sizes**: Precise price expression without lot size restrictions
- **Low Creation Cost**: ~0.007 SOL vs 2-3+ SOL on other DEXs
- **Token22 Support**: Optional performance hit only when needed

## CLI Features

The interactive CLI (`manifest-test.ts`) provides:

- Market creation and delegation to MagicBlock
- Real-time orderbook visualization  
- Order placement and management
- Balance tracking and token wrapping
- Market state inspection

## Performance Comparison

|  |    Openbook    | Phoenix  |Manifest              |**MagicBlock CLOB**   |
|--|----------------|-------------------|----------------------|----------------------|
| Crankless |No |Yes |Yes |**Yes** |
| Feeless |No |No |Yes|**Yes**|
| Atomic lot sizes |No |No |Yes|**Yes**|
| Anchor |Yes |No|No|**No**|
| Creation Rent|2 SOL |3+ SOL |.007 SOL|**.007 SOL**|
| License|GPL |Business |GPL|**GPL**|
| Read optimized| Yes | No | Yes |**Yes** |
| Swap accounts| 16 | 8 | 8 |**8** |
| CU | :white_check_mark: | :white_check_mark: | :white_check_mark: :white_check_mark: |**:white_check_mark: :white_check_mark:** |
| Token 22                                                | No                 | No                 | Yes                                   |**Yes**                                   |
| Composable wrapper                                      | No                 | No                 | Yes                                   |**Yes**                                   |
| Capital Efficient                                       | No                 | No                 | Yes                                   |**Yes**                                   |
| **Latency**                                             | **~400ms**         | **~400ms**         | **~400ms**                            |**<50ms**                                 |
| **Ephemeral Rollups**                                   | **No**             | **No**             | **No**                                |**Yes**                                   |

## Core vs Wrapper Architecture

This prototype maintains Manifest's clean separation:
- **Core Program**: Pure orderbook primitive with minimal features
- **Wrapper Program**: Additional features like ClientOrderId, FillOrKill, etc.
- **MagicBlock Integration**: Ephemeral rollup delegation for speed

## Technical Requirements

- Node.js 14+
- Solana wallet with devnet SOL
- TypeScript and ts-node

## Dependencies

- `@solana/web3.js`: Solana interaction
- `@magicblock-labs/ephemeral-rollups-sdk`: MagicBlock integration
- `@solana/spl-token`: Token operations

## License

GPL-3.0 License - Freedom-maximizing open source

---

*This prototype demonstrates the potential for on-chain orderbooks to achieve CEX-level performance through innovative infrastructure like MagicBlock's ephemeral rollups, while maintaining the transparency and composability of DeFi.*
