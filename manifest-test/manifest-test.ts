//MAKE SURE TO ENTER YOUR PRIVATE KEY ON LINE 63 TO RUN THIS CLI
import { 
  Connection, 
  Keypair, 
  LAMPORTS_PER_SOL, 
  PublicKey, 
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountIdempotent,
  mintTo,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createSyncNativeInstruction,
  getAccount,
  createTransferInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { 
  DELEGATION_PROGRAM_ID, 
  delegationRecordPdaFromDelegatedAccount, 
  delegationMetadataPdaFromDelegatedAccount, 
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import bs58 from "bs58";
import fs from "fs";
import * as readline from 'readline';

// Load the manifest IDL
const manifestIdl = JSON.parse(
  fs.readFileSync("./manifest.json", "utf8")
);

// Configure the client to use the local cluster
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

// Configure ephemeral rollup connection for MagicBlock
const ephemeralConnection = new Connection(
  process.env.PROVIDER_ENDPOINT || "https://devnet.magicblock.app/", 
  {
    wsEndpoint: process.env.WS_ENDPOINT || "wss://devnet.magicblock.app/",
  }
);

// Program IDs
const manifestProgramId = new PublicKey("FASTz9tarYt7xR67mA2zDtr15iQqjsDoU4FxyUrZG8vb");

// Base and Quote mint addresses for market derivation
const baseMint = new PublicKey("So11111111111111111111111111111111111111112"); // SOL (Wrapped SOL)
const quoteMint = new PublicKey("G1vK94GMUtw3cTYHzDiaPox4uGtgsCMJXZ8epi4WgYJZ"); // FAST on devnet

// Test keypairs
const admin = Keypair.fromSecretKey(bs58.decode("enter private key here"));

// Global state to track created resources
interface GlobalState {
  marketPDA?: PublicKey;
  baseMint?: PublicKey;
  quoteMint?: PublicKey;
  baseVault?: PublicKey;
  quoteVault?: PublicKey;
  baseTokenAccount?: PublicKey;
  quoteTokenAccount?: PublicKey;
  seatClaimed?: boolean;
  marketDelegated?: boolean;
}

// Global state - no default market initialization
const state: GlobalState = {

  // These will be derived from the market data or set to known values
  baseMint: new PublicKey("So11111111111111111111111111111111111111112"), // SOL (Wrapped SOL)
  quoteMint: new PublicKey("G1vK94GMUtw3cTYHzDiaPox4uGtgsCMJXZ8epi4WgYJZ"), // FAST on devnet
  marketDelegated: true, // Market is already delegated
};

// Order types
enum OrderType {
  Limit = 0,
  ImmediateOrCancel = 1,
  PostOnly = 2,
  Global = 3,
  Reverse = 4,
}

// Helper function to convert price to mantissa and exponent
function toMantissaAndExponent(price: number): { mantissa: number, exponent: number } {
  let mantissa = price;
  let exponent = 0;
  
  // Normalize mantissa to be between 10^6 and 10^9 to fit in u32
  while (mantissa >= 4294967295) { // u32::MAX
    mantissa /= 10;
    exponent += 1;
  }
  
  while (mantissa < 100000 && exponent > -18) {
    mantissa *= 10;
    exponent -= 1;
  }
  
  return { mantissa: Math.floor(mantissa), exponent };
}

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function to prompt user input
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

// Helper function to wait for user to press Enter
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    rl.question('\nPress Enter to continue...', () => resolve());
  });
}

// Wrap native SOL into a token account for trading
async function wrapSol(connection: Connection, wallet: Keypair, amount: number = 1): Promise<PublicKey> {
    const associatedTokenAccount = await getAssociatedTokenAddress(
        NATIVE_MINT,
        wallet.publicKey
    );

    console.log(`🔄 Wrapping ${amount} SOL...`);
    console.log(`WSOL Token Account: ${associatedTokenAccount.toString()}`);

    // Check if the associated token account already exists
    const accountInfo = await connection.getAccountInfo(associatedTokenAccount);
    
    const wrapTransaction = new Transaction();
    
    // Only add the create instruction if the account doesn't exist
    if (!accountInfo) {
        wrapTransaction.add(
            createAssociatedTokenAccountInstruction(
                wallet.publicKey,
                associatedTokenAccount,
                wallet.publicKey,
                NATIVE_MINT
            )
        );
    }
    
    // Add transfer and sync instructions
    wrapTransaction.add(
        SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: associatedTokenAccount,
            lamports: amount * LAMPORTS_PER_SOL,
        }),
        createSyncNativeInstruction(associatedTokenAccount)
    );
    
    await sendAndConfirmTransaction(connection, wrapTransaction, [wallet]);

    console.log("✅ SOL wrapped successfully");
    return associatedTokenAccount;
}

// Unwrap WSOL back to native SOL
async function unwrapSol(connection: Connection, wallet: Keypair, wsolAccount: PublicKey): Promise<void> {
    console.log('🔄 Unwrapping WSOL back to native SOL...');
    
    const unwrapTransaction = new Transaction().add(
        createCloseAccountInstruction(
            wsolAccount,
            wallet.publicKey,
            wallet.publicKey
        )
    );
    
    await sendAndConfirmTransaction(connection, unwrapTransaction, [wallet]);
    console.log("✅ WSOL unwrapped successfully");
}

// Create CreateMarket instruction
function createCreateMarketInstruction(accounts: {
  payer: PublicKey;
  market: PublicKey;
  systemProgram: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  tokenProgram: PublicKey;
  tokenProgram22: PublicKey;
}): TransactionInstruction {
  // CreateMarket instruction discriminator is 0
  const data = Buffer.alloc(1);
  data.writeUInt8(0, 0);

  const keys = [
    { pubkey: accounts.payer, isWritable: true, isSigner: true },
    { pubkey: accounts.market, isWritable: true, isSigner: false },
    { pubkey: accounts.systemProgram, isWritable: false, isSigner: false },
    { pubkey: accounts.baseMint, isWritable: false, isSigner: false },
    { pubkey: accounts.quoteMint, isWritable: false, isSigner: false },
    { pubkey: accounts.baseVault, isWritable: true, isSigner: false },
    { pubkey: accounts.quoteVault, isWritable: true, isSigner: false },
    { pubkey: accounts.tokenProgram, isWritable: false, isSigner: false },
    { pubkey: accounts.tokenProgram22, isWritable: false, isSigner: false },
  ];

  return new TransactionInstruction({
    programId: manifestProgramId,
    keys,
    data,
  });
}

// Create ClaimSeat instruction
function createClaimSeatInstruction(accounts: {
  payer: PublicKey;
  market: PublicKey;
  systemProgram: PublicKey;
}): TransactionInstruction {
  // ClaimSeat instruction discriminator is 1
  const data = Buffer.alloc(1);
  data.writeUInt8(1, 0);

  const keys = [
    { pubkey: accounts.payer, isWritable: true, isSigner: true },
    { pubkey: accounts.market, isWritable: true, isSigner: false },
    { pubkey: accounts.systemProgram, isWritable: false, isSigner: false },
  ];

  return new TransactionInstruction({
    programId: manifestProgramId,
    keys,
    data,
  });
}

// Create Deposit instruction (state-only, no transfers)
function createDepositInstruction(accounts: {
  payer: PublicKey;
  market: PublicKey;
  traderToken: PublicKey;
  vault: PublicKey;
  tokenProgram: PublicKey;
  mint: PublicKey;
}, params: {
  amountAtoms: bigint;
  traderIndexHint?: number;
}): TransactionInstruction {
  // Create data buffer for DepositParams (without discriminator)
  const data = Buffer.alloc(8 + 5); // u64 + Option<u32>
  let offset = 0;
  
  // Write amount_atoms (u64, little endian)
  // Multiply by 100 to get the correct deposit value
  data.writeBigUInt64LE(params.amountAtoms * 100n, offset);
  offset += 8;
  
  // Write trader_index_hint (Option<u32>)
  if (params.traderIndexHint !== undefined) {
    data.writeUInt8(1, offset); // Some
    offset += 1;
    data.writeUInt32LE(params.traderIndexHint, offset);
    offset += 4;
  } else {
    data.writeUInt8(0, offset); // None
    offset += 1;
  }

  // Create final instruction data with discriminator
  const instructionData = Buffer.alloc(1 + offset);
  instructionData.writeUInt8(2, 0); // Deposit discriminator
  data.copy(instructionData, 1, 0, offset); // Copy params data after discriminator

  const keys = [
    { pubkey: accounts.payer, isWritable: true, isSigner: true },
    { pubkey: accounts.market, isWritable: true, isSigner: false },
    { pubkey: accounts.traderToken, isWritable: false, isSigner: false }, // Read-only
    { pubkey: accounts.vault, isWritable: false, isSigner: false }, // Read-only
    { pubkey: accounts.tokenProgram, isWritable: false, isSigner: false },
    { pubkey: accounts.mint, isWritable: false, isSigner: false },
  ];

  return new TransactionInstruction({
    programId: manifestProgramId,
    keys,
    data: instructionData,
  });
}

// Create BatchUpdate instruction for placing orders
function createBatchUpdateInstruction(accounts: {
  payer: PublicKey;
  market: PublicKey;
  systemProgram: PublicKey;
}, params: {
  traderIndexHint?: number;
  cancels: any[];
  orders: {
    baseAtoms: bigint;
    priceMantissa: number;
    priceExponent: number;
    isBid: boolean;
    lastValidSlot: number;
    orderType: OrderType;
  }[];
}): TransactionInstruction {
  // BatchUpdate instruction discriminator is 6
  let data = Buffer.alloc(1);
  data.writeUInt8(6, 0);

  // Serialize BatchUpdateParams using a simplified approach
  // In a real implementation, you'd use borsh or similar
  const paramsData = Buffer.alloc(1000); // Allocate enough space
  let offset = 0;

  // trader_index_hint (Option<u32>)
  if (params.traderIndexHint !== undefined) {
    paramsData.writeUInt8(1, offset);
    offset += 1;
    paramsData.writeUInt32LE(params.traderIndexHint, offset);
    offset += 4;
  } else {
    paramsData.writeUInt8(0, offset);
    offset += 1;
  }

  // cancels (Vec<CancelOrderParams>) - empty for now
  paramsData.writeUInt32LE(0, offset); // length = 0
  offset += 4;

  // orders (Vec<PlaceOrderParams>)
  paramsData.writeUInt32LE(params.orders.length, offset);
  offset += 4;

  for (const order of params.orders) {
    // baseAtoms (u64)
    paramsData.writeBigUInt64LE(order.baseAtoms, offset);
    offset += 8;
    // priceMantissa (u32)
    paramsData.writeUInt32LE(order.priceMantissa, offset);
    offset += 4;
    // priceExponent (i8)
    paramsData.writeInt8(order.priceExponent, offset);
    offset += 1;
    // isBid (bool)
    paramsData.writeUInt8(order.isBid ? 1 : 0, offset);
    offset += 1;
    // lastValidSlot (u32)
    paramsData.writeUInt32LE(order.lastValidSlot, offset);
    offset += 4;
    // orderType (u8)
    paramsData.writeUInt8(order.orderType, offset);
    offset += 1;
  }

  // Combine discriminator and params
  data = Buffer.concat([data, paramsData.slice(0, offset)]);

  const keys = [
    { pubkey: accounts.payer, isWritable: true, isSigner: true },
    { pubkey: accounts.market, isWritable: true, isSigner: false },
    { pubkey: accounts.systemProgram, isWritable: false, isSigner: false },
  ];

  return new TransactionInstruction({
    programId: manifestProgramId,
    keys,
    data,
  });
}

// Create DelegateMarket instruction
function createDelegateMarketInstruction(accounts: {
  initializer: PublicKey;
  systemProgram: PublicKey;
  marketToDelegate: PublicKey;
  ownerProgram: PublicKey;
  delegationBuffer: PublicKey;
  delegationRecord: PublicKey;
  delegationMetadata: PublicKey;
  delegationProgram: PublicKey;
}): TransactionInstruction {
  // DelegateMarket instruction discriminator is 14
  const data = Buffer.alloc(1);
  data.writeUInt8(14, 0);

  const keys = [
    { pubkey: accounts.initializer, isWritable: true, isSigner: true },
    { pubkey: accounts.systemProgram, isWritable: false, isSigner: false },
    { pubkey: accounts.marketToDelegate, isWritable: true, isSigner: false },
    { pubkey: accounts.ownerProgram, isWritable: false, isSigner: false },
    { pubkey: accounts.delegationBuffer, isWritable: true, isSigner: false },
    { pubkey: accounts.delegationRecord, isWritable: true, isSigner: false },
    { pubkey: accounts.delegationMetadata, isWritable: true, isSigner: false },
    { pubkey: accounts.delegationProgram, isWritable: false, isSigner: false },
  ];

  return new TransactionInstruction({
    programId: manifestProgramId,
    keys,
    data,
  });
}



// Create CommitMarket instruction
function createCommitMarketInstruction(accounts: {
  initializer: PublicKey;
  market: PublicKey;
  magicProgram: PublicKey;
  magicContextId: PublicKey;
}): TransactionInstruction {
  // CommitMarket instruction discriminator is 15
  const data = Buffer.alloc(1);
  data.writeUInt8(15, 0);

  const keys = [
    { pubkey: accounts.initializer, isWritable: true, isSigner: true },
    { pubkey: accounts.market, isWritable: true, isSigner: false },
    { pubkey: accounts.magicProgram, isWritable: false, isSigner: false },
    { pubkey: accounts.magicContextId, isWritable: true, isSigner: false },
  ];

  return new TransactionInstruction({
    programId: manifestProgramId,
    keys,
    data,
  });
}

async function airdrop() {
  console.log("\n=== Airdropping SOL ===");
  const balance = await connection.getBalance(admin.publicKey);
  console.log('Current balance is', balance / LAMPORTS_PER_SOL, ' SOL');
  
  if (balance < LAMPORTS_PER_SOL) {
    console.log('Requesting airdrop of 2 SOL...');
    const airdropSignature = await connection.requestAirdrop(
      admin.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    
    // Wait for confirmation using proper status checking
    while (true) {
      const { value: statuses } = await connection.getSignatureStatuses([airdropSignature]);
      if (!statuses || statuses.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      if (statuses[0] && (statuses[0].confirmationStatus === 'confirmed' || statuses[0].confirmationStatus === 'finalized')) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const newBalance = await connection.getBalance(admin.publicKey);
    console.log('New balance is', newBalance / LAMPORTS_PER_SOL, ' SOL');
    console.log('✅ Airdrop completed');
  } else {
    console.log('Balance sufficient, skipping airdrop');
  }
  
  await waitForEnter();
}

async function createMarket() {
  console.log('\n=== Creating New Market ===');
  
  if (state.marketPDA) {
    console.log('⚠️  A market already exists in this session:');
    console.log(`Market Address: ${state.marketPDA.toString()}`);
    const overwrite = await prompt('Do you want to create a new market anyway? (y/N): ');
    if (overwrite.toLowerCase() !== 'y' && overwrite.toLowerCase() !== 'yes') {
      console.log('❌ Market creation cancelled.');
      await waitForEnter();
      return;
    }
  }
  
  console.log('Creating new market...');
  
  // Use the global base and quote mint addresses
  console.log("Using baseMint (SOL):", baseMint.toString());
  console.log("Using quoteMint (FAST devnet):", quoteMint.toString());

  // Calculate market PDA
  const [marketPDA, marketBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), baseMint.toBuffer(), quoteMint.toBuffer()],
    manifestProgramId
  );

  console.log('Market PDA:', marketPDA.toString());
  console.log('Market bump:', marketBump);

  // Calculate vault PDAs
  const [baseVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPDA.toBuffer(), baseMint.toBuffer()],
    manifestProgramId
  );

  const [quoteVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPDA.toBuffer(), quoteMint.toBuffer()],
    manifestProgramId
  );

  console.log('Base Vault:', baseVault.toString());
  console.log('Quote Vault:', quoteVault.toString());

  // Create market instruction
  const createMarketIx = createCreateMarketInstruction({
    payer: admin.publicKey,
    market: marketPDA,
    systemProgram: SystemProgram.programId,
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenProgram22: TOKEN_2022_PROGRAM_ID,
  });

  // Execute the create market instruction
  const transaction = new Transaction().add(createMarketIx);
  
  try {
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
      [admin]
  );

    console.log('✅ Market created successfully!');
  console.log('Transaction signature:', signature);
  console.log('Market address:', marketPDA.toString());

    // Update global state
    state.marketPDA = marketPDA;
    state.baseMint = baseMint;
    state.quoteMint = quoteMint;
    state.baseVault = baseVault;
    state.quoteVault = quoteVault;
    state.marketDelegated = false; // New market is not delegated
    state.seatClaimed = false; // New market requires seat claiming

    // Fetch and print basic market account data
  console.log('\n=== Market Account Data ===');
    const marketAccountInfo = await connection.getAccountInfo(marketPDA);
    if (marketAccountInfo) {
      console.log('Market account exists:');
      console.log('  Owner:', marketAccountInfo.owner.toString());
      console.log('  Lamports:', marketAccountInfo.lamports);
      console.log('  Data length:', marketAccountInfo.data.length);
      
      if (marketAccountInfo.data.length >= 80) {
        // Read base mint (32 bytes starting at offset 16)
        const baseMintBytes = marketAccountInfo.data.slice(16, 48);
        const baseMintFromData = new PublicKey(baseMintBytes);
        console.log('  Base mint from data:', baseMintFromData.toString());
        console.log('  Base mint matches:', baseMintFromData.equals(baseMint));
        
        // Read quote mint (32 bytes starting at offset 48)
        const quoteMintBytes = marketAccountInfo.data.slice(48, 80);
        const quoteMintFromData = new PublicKey(quoteMintBytes);
        console.log('  Quote mint from data:', quoteMintFromData.toString());
        console.log('  Quote mint matches:', quoteMintFromData.equals(quoteMint));
      }
    } else {
      console.log('❌ Market account not found!');
    }
  } catch (error) {
    console.error('❌ Error creating market:', error);
  }

  await waitForEnter();
}

async function delegateMarket() {
  if (!state.marketPDA) {
    console.log('❌ No market found. Please create a market first.');
    await waitForEnter();
    return;
  }

  if (state.marketDelegated) {
      console.log('\n=== Market Delegation Status ===');
  console.log('✅ Market is already delegated to ephemeral rollup');
  console.log(`Market Address: ${state.marketPDA.toString()}`);
  console.log(`Ephemeral RPC: ${ephemeralConnection.rpcEndpoint}`);

    await waitForEnter();
    return;
  }

  console.log('\n=== Delegating Market ===');
  
  // Use ephemeral rollups SDK to get correct delegation PDAs
  const delegationBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(state.marketPDA, manifestProgramId);
  const delegationRecord = delegationRecordPdaFromDelegatedAccount(state.marketPDA);
  const delegationMetadata = delegationMetadataPdaFromDelegatedAccount(state.marketPDA);

  console.log('Delegation buffer:', delegationBuffer.toString());
  console.log('Delegation record:', delegationRecord.toString());
  console.log('Delegation metadata:', delegationMetadata.toString());

  // Create delegate market instruction
  const delegateIx = createDelegateMarketInstruction({
    initializer: admin.publicKey,
    systemProgram: SystemProgram.programId,
    marketToDelegate: state.marketPDA,
    ownerProgram: manifestProgramId,
    delegationBuffer,
    delegationRecord,
    delegationMetadata,
    delegationProgram: DELEGATION_PROGRAM_ID,
  });

  // Execute delegation instruction
  const transaction = new Transaction().add(delegateIx);
  
  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [admin]
    );

    console.log('✅ Market delegated successfully!');
    console.log('Transaction signature:', signature);
    state.marketDelegated = true;
  } catch (error) {
    console.error('❌ Error delegating market:', error);
  }

  await waitForEnter();
}

async function commitMarket() {
  if (!state.marketPDA) {
    console.log('❌ No market found. Please create a market first.');
    await waitForEnter();
    return;
  }

  if (!state.marketDelegated) {
    console.log('❌ Market is not delegated. Please delegate the market first.');
    await waitForEnter();
    return;
  }

  console.log('\n=== Committing Market ===');
  console.log('🔄 This operation commits the delegated market state to the base layer');
  console.log('📡 Transaction will be sent to MagicBlock ephemeral rollup provider');
  console.log(`   Ephemeral RPC: ${ephemeralConnection.rpcEndpoint}`);
  console.log(`   Market: ${state.marketPDA.toString()}`);

  
  const confirm = await prompt('Do you want to proceed with market commit? (y/N): ');
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    console.log('❌ Operation cancelled.');
    await waitForEnter();
    return;
  }

  // Create commit market instruction
  const commitMarketIx = createCommitMarketInstruction({
    initializer: admin.publicKey,
    market: state.marketPDA,
    magicProgram: MAGIC_PROGRAM_ID,
    magicContextId: MAGIC_CONTEXT_ID,
  });

  console.log('\n📦 Creating transaction for ephemeral rollup...');

  // Create transaction for ephemeral rollup
  const transaction = new Transaction().add(commitMarketIx);

  try {
    console.log('🚀 Sending transaction to ephemeral rollup...');
    
    // Send transaction to ephemeral rollup with skipPreflight
    const txHash = await sendAndConfirmTransaction(
      ephemeralConnection,
      transaction,
      [admin],
      {
        skipPreflight: true,
        commitment: "confirmed"
      }
    );
    
    console.log('✅ Transaction confirmed on ephemeral rollup!');
    console.log('Transaction hash:', txHash);

    console.log('✅ Market committed successfully!');
    console.log('Ephemeral transaction hash:', txHash);


    
  } catch (error) {
    console.error('❌ Error committing market:', error);

  }

  await waitForEnter();
}

async function claimSeat() {
  if (!state.marketPDA) {
    state.marketPDA = new PublicKey("5zv2PEb1mfQJ8tEPZjJBiRW4Tbxv57aer5UCWymteZB3");
    return;
  }

  console.log('\n=== Claiming Seat ===');
  
  const claimSeatIx = createClaimSeatInstruction({
    payer: admin.publicKey,
    market: state.marketPDA,
    systemProgram: SystemProgram.programId,
  });

  const transaction = new Transaction().add(claimSeatIx);
  
  try {
  const signature = await sendAndConfirmTransaction(
    ephemeralConnection,
    transaction,
    [admin],
    {
      skipPreflight: true,
      commitment: "confirmed"
    }
  );

    console.log('✅ Seat claimed successfully!');
    console.log('Transaction signature:', signature);
    state.seatClaimed = true;
  } catch (error) {
    console.error('❌ Error claiming seat:', error);
  }

  await waitForEnter();
}

async function setupTokenAccounts() {
  if (!state.baseMint || !state.quoteMint) {
    console.log('❌ No mints found. Please create a market first.');
    await waitForEnter();
    return;
  }

  console.log('\n=== Setting Up Token Accounts ===');
  
  // Check if base mint is native SOL (wrapped SOL)
  const isBaseMintSOL = state.baseMint.equals(NATIVE_MINT);
  
  console.log(`Base Mint: ${state.baseMint.toString()} ${isBaseMintSOL ? '(Native SOL - will be wrapped)' : ''}`);
  console.log(`Quote Mint: ${state.quoteMint.toString()}`);
  
  // Get associated token account addresses
  const baseTokenAccount = getAssociatedTokenAddressSync(
    state.baseMint,
    admin.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  
  const quoteTokenAccount = getAssociatedTokenAddressSync(
    state.quoteMint,
    admin.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  console.log('Base token account:', baseTokenAccount.toString());
  console.log('Quote token account:', quoteTokenAccount.toString());

  // Check if accounts already exist
  console.log('\n🔍 Checking if token accounts exist...');
  const baseAccountInfo = await connection.getAccountInfo(baseTokenAccount);
  const quoteAccountInfo = await connection.getAccountInfo(quoteTokenAccount);
  
  console.log(`Base ATA exists: ${baseAccountInfo ? '✅ Yes' : '❌ No'}`);
  console.log(`Quote ATA exists: ${quoteAccountInfo ? '✅ Yes' : '❌ No'}`);

  // Create ATAs if they don't exist
  let accountsCreated = 0;
  
  if (!baseAccountInfo) {
    console.log('🔨 Creating base token account...');
    try {
      await createAssociatedTokenAccountIdempotent(
        connection,
        admin,
        state.baseMint,
        admin.publicKey,
        {},
        TOKEN_PROGRAM_ID
      );
      accountsCreated++;
      console.log('✅ Base token account created!');
    } catch (error) {
      console.error('❌ Error creating base token account:', error);
      await waitForEnter();
      return;
    }
  }
  
  if (!quoteAccountInfo) {
    console.log('🔨 Creating quote token account...');
    try {
      await createAssociatedTokenAccountIdempotent(
        connection,
        admin,
        state.quoteMint,
        admin.publicKey,
        {},
        TOKEN_PROGRAM_ID
      );
      accountsCreated++;
      console.log('✅ Quote token account created!');
    } catch (error) {
      console.error('❌ Error creating quote token account:', error);
      await waitForEnter();
      return;
    }
  }

  if (accountsCreated > 0) {
    console.log(`\n✅ Created ${accountsCreated} token account(s) successfully!`);
  } else {
    console.log('✅ All token accounts already exist!');
  }

  // Update global state
  state.baseTokenAccount = baseTokenAccount;
  state.quoteTokenAccount = quoteTokenAccount;

  // Handle SOL wrapping if needed
  if (isBaseMintSOL) {
    console.log('\n🌯 SOL Wrapping Options:');
    console.log('Since the base mint is native SOL, you may want to wrap some SOL for trading.');
    
    const wrapChoice = await prompt('Do you want to wrap some SOL now? (y/N): ');
    if (wrapChoice.toLowerCase() === 'y' || wrapChoice.toLowerCase() === 'yes') {
      const amountStr = await prompt('How much SOL to wrap? (default: 1): ');
      const amount = parseFloat(amountStr) || 1;
      
      try {
        // Check current balance first
        const balance = await connection.getBalance(admin.publicKey);
        const balanceSOL = balance / LAMPORTS_PER_SOL;
        
        if (balanceSOL < amount + 0.01) { // Leave some for fees
          console.log(`❌ Insufficient SOL balance. Have: ${balanceSOL}, need: ${amount + 0.01}`);
        } else {
          await wrapSol(connection, admin, amount);
          console.log(`✅ Wrapped ${amount} SOL successfully!`);
        }
      } catch (error) {
        console.error('❌ Error wrapping SOL:', error);
      }
    }
  }

  // Check final balances
  console.log('\n💰 Token Account Balances:');
  try {
    const baseBalance = await connection.getTokenAccountBalance(baseTokenAccount);
    const quoteBalance = await connection.getTokenAccountBalance(quoteTokenAccount);
    
    const baseSymbol = isBaseMintSOL ? 'WSOL' : 'BASE';
    const quoteSymbol = 'FAST';
    
    console.log(`${baseSymbol}: ${baseBalance.value.uiAmount || 0}`);
    console.log(`${quoteSymbol}: ${quoteBalance.value.uiAmount || 0}`);
    
    if (isBaseMintSOL && (baseBalance.value.uiAmount || 0) > 0) {
      console.log('\n🔄 WSOL Management:');
      const unwrapChoice = await prompt('Do you want to unwrap any WSOL back to native SOL? (y/N): ');
      if (unwrapChoice.toLowerCase() === 'y' || unwrapChoice.toLowerCase() === 'yes') {
        try {
          await unwrapSol(connection, admin, baseTokenAccount);
        } catch (error) {
          console.error('❌ Error unwrapping SOL:', error);
        }
      }
    }
  } catch (error) {
    console.log('Could not fetch token balances (accounts may be empty)');
  }

  await waitForEnter();
}



async function placeOrders() {
  if (!state.marketPDA) {
    console.log('❌ No market found. Please create a market first.');
    await waitForEnter();
    return;
  }

  if (!state.seatClaimed) {
    console.log('❌ Seat not claimed. Please claim a seat first.');
    await waitForEnter();
    return;
  }

  console.log('\n=== Placing Orders ===');
  console.log('Enter order details (press Enter with empty amount to finish):');

  const orders: any[] = [];

  while (true) {
    console.log(`\n--- Order ${orders.length + 1} ---`);
    const amountStr = await prompt('Amount (in base tokens, e.g., 0.5 for 0.5 SOL): ');
    
    if (!amountStr.trim()) {
      break;
    }

    const amount = parseFloat(amountStr);
    if (amount <= 0) {
      console.log('❌ Invalid amount. Please enter a positive number.');
      continue;
    }

    const priceStr = await prompt('Price (in quote tokens per base token, e.g., 100 for 100 FAST/SOL): ');
    const price = parseFloat(priceStr);
    if (price <= 0) {
      console.log('❌ Invalid price. Please enter a positive number.');
      continue;
    }

    const sideStr = (await prompt('Side (buy/sell): ')).toLowerCase();
    if (sideStr !== 'buy' && sideStr !== 'sell') {
      console.log('❌ Invalid side. Please enter "buy" or "sell".');
      continue;
    }

    const orderTypeStr = (await prompt('Order type (limit/ioc/postonly) [default: limit]: ')).toLowerCase() || 'limit';
    let orderType = OrderType.Limit;
    switch (orderTypeStr) {
      case 'ioc':
        orderType = OrderType.ImmediateOrCancel;
        break;
      case 'postonly':
        orderType = OrderType.PostOnly;
        break;
      default:
        orderType = OrderType.Limit;
    }

    const baseAtoms = BigInt(Math.floor(amount * 1_000_000_000)); // Convert to lamports
    const { mantissa: priceMantissa, exponent: priceExponent } = toMantissaAndExponent(price);

    orders.push({
      baseAtoms,
      priceMantissa,
      priceExponent,
      isBid: sideStr === 'buy',
      lastValidSlot: 0, // No expiration
      orderType,
    });

    console.log(`✅ Added ${sideStr} order: ${amount} at ${price} (mantissa: ${priceMantissa}, exp: ${priceExponent})`);
  }

  if (orders.length === 0) {
    console.log('No orders to place.');
    await waitForEnter();
    return;
  }

  const batchUpdateIx = createBatchUpdateInstruction({
    payer: admin.publicKey,
    market: state.marketPDA,
    systemProgram: SystemProgram.programId,
  }, {
    cancels: [],
    orders,
  });

  console.log(`\n📋 Created batch update instruction with ${orders.length} orders:`);
  orders.forEach((order, i) => {
    const side = order.isBid ? 'BUY' : 'SELL';
    const amount = Number(order.baseAtoms) / 1_000_000_000;
    const price = order.priceMantissa * Math.pow(10, order.priceExponent);
    console.log(`  ${i + 1}. ${side} ${amount} SOL at ${price} FAST/SOL`);
  });

  const execute = await prompt('\nExecute this transaction? (y/N): ');
  if (execute.toLowerCase() === 'y' || execute.toLowerCase() === 'yes') {
    const transaction = new Transaction().add(batchUpdateIx);
    
    try {
      const signature = await sendAndConfirmTransaction(
        ephemeralConnection,
        transaction,
        [admin],
        {
          skipPreflight: true,
          commitment: "confirmed"
        }
      );

      console.log('✅ Orders placed successfully!');
  console.log('Transaction signature:', signature);
    } catch (error) {
      console.error('❌ Error placing orders:', error);
    }
  } else {
    console.log('Transaction not executed.');
  }

  await waitForEnter();
}





async function depositWithExternalTransfers() {
  if (!state.marketPDA || !state.baseMint || !state.quoteMint || !state.baseVault || !state.quoteVault || !state.baseTokenAccount || !state.quoteTokenAccount) {
    console.log('❌ Missing required state. Please complete previous steps first.');
    await waitForEnter();
    return;
  }

  if (!state.seatClaimed) {
    console.log('❌ Seat not claimed. Please claim a seat first.');
    await waitForEnter();
    return;
  }

  console.log('\n=== Depositing with External Transfers ===');
  
  // Get deposit amounts from user
  const baseAmountStr = await prompt('Enter base token amount to deposit (SOL): ');
  const quoteAmountStr = await prompt('Enter quote token amount to deposit (FAST): ');
  
  const baseAmount = parseFloat(baseAmountStr) || 0;
  const quoteAmount = parseFloat(quoteAmountStr) || 0;
  
  if (baseAmount <= 0 && quoteAmount <= 0) {
    console.log('❌ Invalid amounts. Please enter positive numbers.');
    await waitForEnter();
    return;
  }

  const { createTransferInstruction } = await import('@solana/spl-token');
  const instructions: TransactionInstruction[] = [];

  // Step 1: Add external transfers
  if (baseAmount > 0) {
    const baseTransferAmount = BigInt(Math.floor(baseAmount * 1_000_000_000)); // Convert to lamports
    
    const baseTransferIx = createTransferInstruction(
      state.baseTokenAccount,  // from
      state.baseVault,         // to
      admin.publicKey,         // owner
      baseTransferAmount,      // amount
      [],                      // multiSigners
      TOKEN_PROGRAM_ID         // programId
    );

    instructions.push(baseTransferIx);
    console.log(`Will transfer ${baseTransferAmount} base atoms (${baseAmount} SOL)`);
    
    // Step 2: Add deposit instruction for base
    const baseDepositIx = createDepositInstruction({
      payer: admin.publicKey,
      market: state.marketPDA,
      traderToken: state.baseTokenAccount,
      vault: state.baseVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      mint: state.baseMint,
    }, {
      amountAtoms: baseTransferAmount,
    });

    instructions.push(baseDepositIx);
    console.log(`Will update market accounting for ${baseTransferAmount} base atoms`);
  }

  if (quoteAmount > 0) {
    const quoteTransferAmount = BigInt(Math.floor(quoteAmount * 1_000_000)); // Convert to micro-FAST
    
    const quoteTransferIx = createTransferInstruction(
      state.quoteTokenAccount, // from
      state.quoteVault,        // to
      admin.publicKey,         // owner
      quoteTransferAmount,     // amount
      [],                      // multiSigners
      TOKEN_PROGRAM_ID         // programId
    );

    instructions.push(quoteTransferIx);
    console.log(`Will transfer ${quoteTransferAmount} quote atoms (${quoteAmount} FAST)`);
    
    // Step 2: Add deposit instruction for quote
    const quoteDepositIx = createDepositInstruction({
      payer: admin.publicKey,
      market: state.marketPDA,
      traderToken: state.quoteTokenAccount,
      vault: state.quoteVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      mint: state.quoteMint,
    }, {
      amountAtoms: quoteTransferAmount,
    });

    instructions.push(quoteDepositIx);
    console.log(`Will update market accounting for ${quoteTransferAmount} quote atoms`);
  }

  if (instructions.length > 0) {
    // Split instructions into transfers and deposits
    const transferInstructions: TransactionInstruction[] = [];
    const depositInstructions: TransactionInstruction[] = [];
    
    for (let i = 0; i < instructions.length; i++) {
      if (i % 2 === 0) {
        // Even indices are transfers
        transferInstructions.push(instructions[i]);
      } else {
        // Odd indices are deposits
        depositInstructions.push(instructions[i]);
      }
    }
    
    console.log('\n📦 Executing split transactions...');
    console.log(`   ${transferInstructions.length} transfer instructions → Regular devnet`);
    console.log(`   ${depositInstructions.length} deposit instructions → Ephemeral rollup`);
    
    try {
      // Step 1: Execute transfers on regular devnet
      if (transferInstructions.length > 0) {
        console.log('\n🔄 Step 1: Executing token transfers on regular devnet...');
        const transferTransaction = new Transaction().add(...transferInstructions);
        
        const transferSignature = await sendAndConfirmTransaction(
          connection, // Regular devnet connection
          transferTransaction,
          [admin],
          {
            skipPreflight: true,
            commitment: "confirmed"
          }
        );
        
        console.log('✅ Token transfers completed!');
        console.log('Transfer transaction signature:', transferSignature);
      }
      
      // Step 2: Execute deposits on ephemeral rollup
      if (depositInstructions.length > 0) {
        console.log('\n🔄 Step 2: Executing deposit state updates on ephemeral rollup...');
        const depositTransaction = new Transaction().add(...depositInstructions);
        
        const depositSignature = await sendAndConfirmTransaction(
          ephemeralConnection, // Ephemeral rollup connection
          depositTransaction,
          [admin],
          {
            skipPreflight: true,
            commitment: "confirmed"
          }
        );
        
        console.log('✅ Deposit state updates completed!');
        console.log('Deposit transaction signature:', depositSignature);
      }
      
      console.log('\n✅ Split deposit process completed successfully!');
      
      if (baseAmount > 0) {
        console.log(`✅ Deposited ${baseAmount} SOL to market (transfer on devnet + state update on ER)`);
      }
      if (quoteAmount > 0) {
        console.log(`✅ Deposited ${quoteAmount} FAST to market (transfer on devnet + state update on ER)`);
      }
      

      
    } catch (error) {
      console.error('❌ Error executing split deposits:', error);
    }
  } else {
    console.log('❌ No deposits to execute.');
  }

  await waitForEnter();
}

// Helper functions for parsing orderbook data
interface ParsedOrder {
  price: number;
  size: number;
  sequenceNumber: bigint;
  traderIndex: number;
  lastValidSlot: number;
  isBid: boolean;
  orderType: string;
  isExpired: boolean;
}

// Parse a RestingOrder from 64 bytes of data
function parseRestingOrder(data: Buffer, offset: number, currentSlot: number): ParsedOrder {
  // RestingOrder structure (64 bytes) from resting_order.rs:
  // price: QuoteAtomsPerBaseAtom (16 bytes) - mantissa (u64) + exponent (i64)
  // num_base_atoms: BaseAtoms (8 bytes) 
  // sequence_number: u64 (8 bytes)
  // trader_index: DataIndex (4 bytes)
  // last_valid_slot: u32 (4 bytes)
  // is_bid: PodBool (1 byte)
  // order_type: OrderType (1 byte)
  // reverse_spread: u16 (2 bytes)
  // padding: [u8; 20] (20 bytes)

  try {
    // Parse price (16 bytes) - stored as mantissa (u64) + exponent (i64)
    const priceMantissa = data.readBigUInt64LE(offset);
    const priceExponent = data.readBigInt64LE(offset + 8);
    
    // Handle price calculation more carefully
    let price = 0;
    if (priceMantissa > 0n) {
      const mantissaNum = Number(priceMantissa);
      const exponentNum = Number(priceExponent);
      // Calculate price and convert from atomic units to human readable
      // Quote token has 9 decimals, base token has 9 decimals
      price = (mantissaNum * Math.pow(10, exponentNum)) / 1_000_000_000;
    }

    // Parse base atoms (8 bytes)
    const baseAtoms = data.readBigUInt64LE(offset + 16);
    const size = Number(baseAtoms) / 1_000_000_000; // Convert from lamports to SOL

    // Parse sequence number (8 bytes)
    const sequenceNumber = data.readBigUInt64LE(offset + 24);

    // Parse trader index (4 bytes)
    const traderIndex = data.readUInt32LE(offset + 32);

    // Parse last valid slot (4 bytes)
    const lastValidSlot = data.readUInt32LE(offset + 36);

    // Parse is_bid (1 byte)
    const isBid = data.readUInt8(offset + 40) === 1;

    // Parse order type (1 byte)
    const orderTypeNum = data.readUInt8(offset + 41);
    const orderTypeNames = ['Limit', 'ImmediateOrCancel', 'PostOnly', 'Global', 'Reverse'];
    const orderType = orderTypeNames[orderTypeNum] || 'Unknown';

    // Check if expired (0 means no expiration)
    const isExpired = lastValidSlot !== 0 && lastValidSlot < currentSlot;

    return {
      price,
      size,
      sequenceNumber,
      traderIndex,
      lastValidSlot,
      isBid,
      orderType,
      isExpired
    };
  } catch (error) {
    console.log(`Error parsing RestingOrder at offset ${offset}:`, error);
    return {
      price: 0,
      size: 0,
      sequenceNumber: 0n,
      traderIndex: 0,
      lastValidSlot: 0,
      isBid: false,
      orderType: 'Unknown',
      isExpired: true
    };
  }
}

// Parse RBNode structure (80 bytes total, 16 bytes overhead + 64 bytes payload)
function parseRBNode(data: Buffer, index: number, currentSlot: number): {
  leftIndex: number;
  rightIndex: number;
  parentIndex: number;
  order: ParsedOrder;
} {
  const BLOCK_SIZE = 80;
  const offset = index; // index is already a byte offset, not a node index

  if (offset + BLOCK_SIZE > data.length) {
    throw new Error(`Invalid node index ${index}, would read beyond data bounds (need ${offset + BLOCK_SIZE}, have ${data.length})`);
  }

  // RBNode structure (first 16 bytes):
  // left: DataIndex (4 bytes)
  // right: DataIndex (4 bytes) 
  // parent: DataIndex (4 bytes)
  // color: Color (1 byte)
  // payload_type: u8 (1 byte)
  // padding: u16 (2 bytes)
  // value: RestingOrder (64 bytes)

  const leftIndex = data.readUInt32LE(offset);
  const rightIndex = data.readUInt32LE(offset + 4);
  const parentIndex = data.readUInt32LE(offset + 8);

  // Parse the RestingOrder (starts at offset + 16)
  const order = parseRestingOrder(data, offset + 16, currentSlot);

  return {
    leftIndex,
    rightIndex,
    parentIndex,
    order
  };
}

// Traverse the red-black tree in-order to get sorted orders
function traverseOrderTree(
  data: Buffer, 
  rootIndex: number, 
  currentSlot: number,
  maxOrders: number = 10
): { orders: ParsedOrder[], totalCount: number } {
  const NIL = 0xFFFFFFFF; // u32::MAX
  const orders: ParsedOrder[] = [];
  let totalCount = 0;

  function inOrderTraversal(nodeIndex: number) {
    if (nodeIndex === NIL) {
      return;
    }

    try {
      const node = parseRBNode(data, nodeIndex, currentSlot);
      totalCount++;
      
      // Visit left subtree first (lower prices for asks, higher prices for bids)
      if (node.leftIndex !== NIL) {
        inOrderTraversal(node.leftIndex);
      }

      // Visit current node (only add to orders if we haven't reached max)
      if (orders.length < maxOrders && node.order.size > 0 && !node.order.isExpired) {
        orders.push(node.order);
      }

      // Visit right subtree
      if (node.rightIndex !== NIL) {
        inOrderTraversal(node.rightIndex);
      }
    } catch (error) {
      console.log(`Error parsing node at index ${nodeIndex}:`, error instanceof Error ? error.message : String(error));
    }
  }

  if (rootIndex !== NIL) {
    inOrderTraversal(rootIndex);
  }

  return { orders, totalCount };
}

async function fetchOrderbook() {
  if (!state.marketPDA) {
    console.log('❌ No market found. Please create a market first.');
    await waitForEnter();
    return;
  }

  console.log('\n=== Fetching Orderbook ===');
  console.log(`📖 Reading market data from ephemeral rollup`);
  console.log(`   Market: ${state.marketPDA.toString()}`);
  console.log(`   Ephemeral RPC: ${ephemeralConnection.rpcEndpoint}`);

  try {
    // Fetch the market account data from ephemeral rollup
    const marketAccountInfo = await ephemeralConnection.getAccountInfo(state.marketPDA);
    
    if (!marketAccountInfo) {
      console.log('❌ Market account not found on ephemeral rollup');
      await waitForEnter();
      return;
    }

    console.log(`✅ Market account found`);
    console.log(`   Owner: ${marketAccountInfo.owner.toString()}`);
    console.log(`   Data length: ${marketAccountInfo.data.length} bytes`);

    // Parse the fixed header (MarketFixed is 256 bytes according to the program)
    const MARKET_FIXED_SIZE = 256;
    if (marketAccountInfo.data.length < MARKET_FIXED_SIZE) {
      console.log('❌ Market account data too small');
      await waitForEnter();
      return;
    }

    const data = marketAccountInfo.data;
    let offset = 0;

    // Read MarketFixed structure
    const discriminant = data.readBigUInt64LE(offset); offset += 8;
    const version = data.readUInt8(offset); offset += 1;
    const baseMintDecimals = data.readUInt8(offset); offset += 1;
    const quoteMintDecimals = data.readUInt8(offset); offset += 1;
    const baseVaultBump = data.readUInt8(offset); offset += 1;
    const quoteVaultBump = data.readUInt8(offset); offset += 1;
    offset += 3; // padding

    // Read mints and vaults (32 bytes each)
    const baseMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const quoteMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const baseVault = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const quoteVault = new PublicKey(data.slice(offset, offset + 32)); offset += 32;

    const orderSequenceNumber = data.readBigUInt64LE(offset); offset += 8;
    const numBytesAllocated = data.readUInt32LE(offset); offset += 4;

    // Read tree indices (4 bytes each)
    const bidsRootIndex = data.readUInt32LE(offset); offset += 4;
    const bidsBestIndex = data.readUInt32LE(offset); offset += 4;
    const asksRootIndex = data.readUInt32LE(offset); offset += 4;
    const asksBestIndex = data.readUInt32LE(offset); offset += 4;
    const claimedSeatsRootIndex = data.readUInt32LE(offset); offset += 4;
    const freeListHeadIndex = data.readUInt32LE(offset); offset += 4;

    offset += 4; // padding2
    const quoteVolume = data.readBigUInt64LE(offset); offset += 8;

    console.log('\n📊 Market Header Info:');
    console.log(`   Version: ${version}`);
    console.log(`   Base Mint: ${baseMint.toString()}`);
    console.log(`   Quote Mint: ${quoteMint.toString()}`);
    console.log(`   Order Sequence Number: ${orderSequenceNumber}`);
    console.log(`   Allocated Bytes: ${numBytesAllocated}`);
    console.log(`   Quote Volume: ${Number(quoteVolume) / 1_000_000_00}`);
    console.log(`   Bids Root: ${bidsRootIndex}, Best: ${bidsBestIndex}`);
    console.log(`   Asks Root: ${asksRootIndex}, Best: ${asksBestIndex}`);

    // Check if there are any orders
    const NIL = 0xFFFFFFFF; // u32::MAX
    const hasBids = bidsRootIndex !== NIL;
    const hasAsks = asksRootIndex !== NIL;

    if (!hasBids && !hasAsks) {
      console.log('\n📖 Orderbook is empty (no bids or asks)');
      await waitForEnter();
      return;
    }

    // Parse dynamic section 
    const dynamicData = data.slice(MARKET_FIXED_SIZE);

    // Get current slot for expiration checking
    const currentSlot = (await ephemeralConnection.getSlot()) || 0;

    if (hasBids) {
      console.log(`\n🟢 BIDS`);
      try {
        const bidResult = traverseOrderTree(dynamicData, bidsRootIndex, currentSlot, 10);
        
        console.log(`   Found ${bidResult.totalCount} total bid orders`);
        
        if (bidResult.orders.length > 0) {
          console.log('   Price (FAST/SOL) | Size (SOL) | Sequence | Trader | Type | Status');
          console.log('   ─────────────────┼────────────┼──────────┼────────┼──────┼───────');
          
          // Sort bids by price descending (highest bids first)
          bidResult.orders
            .filter(order => order.isBid)
            .sort((a, b) => b.price - a.price)
            .slice(0, 10)
            .forEach(order => {
              const status = order.isExpired ? 'EXPIRED' : 'ACTIVE';
              const priceStr = order.price.toFixed(6).padStart(16);
              const sizeStr = order.size.toFixed(6).padStart(10);
              const seqStr = order.sequenceNumber.toString().padStart(8);
              const traderStr = order.traderIndex.toString().padStart(6);
              const typeStr = order.orderType.padStart(6);
              const statusStr = status.padStart(7);
              
              console.log(`   ${priceStr} │ ${sizeStr} │ ${seqStr} │ ${traderStr} │ ${typeStr} │ ${statusStr}`);
            });
        } else {
          console.log('   No valid bid orders found');
        }
      } catch (error) {
        console.log(`   Error parsing bids: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (hasAsks) {
      console.log(`\n🔴 ASKS`);
      try {
        const askResult = traverseOrderTree(dynamicData, asksRootIndex, currentSlot, 10);
        
        console.log(`   Found ${askResult.totalCount} total ask orders`);
        
        if (askResult.orders.length > 0) {
          console.log('   Price (FAST/SOL) | Size (SOL) | Sequence | Trader | Type | Status');
          console.log('   ─────────────────┼────────────┼──────────┼────────┼──────┼───────');
          
          // Sort asks by price ascending (lowest asks first)
          askResult.orders
            .filter(order => !order.isBid)
            .sort((a, b) => a.price - b.price)
            .slice(0, 10)
            .forEach(order => {
              const status = order.isExpired ? 'EXPIRED' : 'ACTIVE';
              const priceStr = order.price.toFixed(6).padStart(16);
              const sizeStr = order.size.toFixed(6).padStart(10);
              const seqStr = order.sequenceNumber.toString().padStart(8);
              const traderStr = order.traderIndex.toString().padStart(6);
              const typeStr = order.orderType.padStart(6);
              const statusStr = status.padStart(7);
              
              console.log(`   ${priceStr} │ ${sizeStr} │ ${seqStr} │ ${traderStr} │ ${typeStr} │ ${statusStr}`);
            });
        } else {
          console.log('   No valid ask orders found');
        }
      } catch (error) {
        console.log(`   Error parsing asks: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Show summary
    console.log('\n📈 Orderbook Summary:');
    if (hasBids || hasAsks) {
      let bidCount = 0;
      let askCount = 0;
      
      if (hasBids) {
        try {
          const bidResult = traverseOrderTree(dynamicData, bidsRootIndex, currentSlot, 0);
          bidCount = bidResult.totalCount;
        } catch (error) {
          console.log('   Error counting bids');
        }
      }
      
      if (hasAsks) {
        try {
          const askResult = traverseOrderTree(dynamicData, asksRootIndex, currentSlot, 0);
          askCount = askResult.totalCount;
        } catch (error) {
          console.log('   Error counting asks');
        }
      }
      
      console.log(`   Market has ${bidCount} bids and ${askCount} asks`);
      console.log(`   Total quote volume traded: ${Number(quoteVolume) / 1_000_000_00}`);
    }

  } catch (error) {
    console.error('❌ Error fetching orderbook:', error);
  }

  await waitForEnter();
}

function displayMenu() {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                   🚀 MANIFEST TRADING CLI                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Admin Public Key: ${admin.publicKey.toString()}`);
  console.log(`Network: Devnet`);
  console.log('');
  
  // Display current state
  console.log('📊 Current State:');
  console.log(`  Market: ${state.marketPDA ? '✅ Pre-initialized' : '❌ Not found'}`);
  console.log(`  Delegation: ${state.marketDelegated ? '✅ Delegated' : (state.marketPDA ? '❌ Not delegated' : '❌ No market')}`);
  console.log(`  Seat: ${state.seatClaimed ? '✅ Claimed' : '❌ Not claimed'}`);
  console.log(`  Token Accounts: ${state.baseTokenAccount && state.quoteTokenAccount ? '✅ Identified' : '❌ Not set up'}`);
  console.log('');

  console.log('🔧 Available Actions:');
  console.log('  1. Airdrop SOL');
  console.log('  2. Create Market on Base layer (Devnet)');
  console.log('  3. Delegate Market to Magicblock ER');
  console.log('  4. Commit Market on Magicblock');
  console.log('  5. Claim Seat on Market (Magicblock)');
  console.log('  6. Setup Token ATAs');
  console.log('  7. Deposit Funds to Vaults and update orderbook on Magicblock');
  console.log('  8. Place Orders on Magicblock');
  console.log('  9. View State Details on Magicblock');
  console.log('  10. Fetch Orderbook on Magicblock');
  console.log('  11. Manage SOL Wrapping');
  console.log('  12. Exit');
  console.log('');
}

async function viewStateDetails() {
  console.log('\n=== 📊 Detailed State Information ===');
  
  if (state.marketPDA) {
    console.log(`\n🏪 Market:`);
    console.log(`  Address: ${state.marketPDA.toString()}`);
    console.log(`  Base Mint: ${state.baseMint?.toString() || 'N/A'}`);
    console.log(`  Quote Mint: ${state.quoteMint?.toString() || 'N/A'}`);
    console.log(`  Base Vault: ${state.baseVault?.toString() || 'N/A'}`);
    console.log(`  Quote Vault: ${state.quoteVault?.toString() || 'N/A'}`);
  }

  if (state.baseTokenAccount || state.quoteTokenAccount) {
    console.log(`\n💰 Token Accounts:`);
    console.log(`  Base Token Account: ${state.baseTokenAccount?.toString() || 'N/A'}`);
    console.log(`  Quote Token Account: ${state.quoteTokenAccount?.toString() || 'N/A'}`);
  }

  console.log(`\n🎫 Trading Status:`);
  console.log(`  Seat Claimed: ${state.seatClaimed ? 'Yes' : 'No'}`);
  
  console.log(`\n🔗 Delegation Status:`);
  console.log(`  Market Delegated: ${state.marketDelegated ? 'Yes' : 'No'}`);
  if (state.marketDelegated) {
    console.log(`  Ephemeral Rollup: ${ephemeralConnection.rpcEndpoint}`);
  }
  
  console.log(`\n🔗 Program IDs:`);
  console.log(`  Manifest: ${manifestProgramId.toString()}`);
  console.log(`  Delegation: ${DELEGATION_PROGRAM_ID.toString()}`);
  console.log(`  MagicBlock Program: ${MAGIC_PROGRAM_ID.toString()}`);
  console.log(`  MagicBlock Context: ${MAGIC_CONTEXT_ID.toString()}`);

  await waitForEnter();
}

async function manageSolWrapping() {
  console.log('\n=== SOL Wrapping Management ===');
  
  const wsolAccount = await getAssociatedTokenAddress(
    NATIVE_MINT,
    admin.publicKey
  );
  
  console.log(`WSOL Account: ${wsolAccount.toString()}`);
  
  // Check current balances
  const nativeBalance = await connection.getBalance(admin.publicKey);
  const nativeSOL = nativeBalance / LAMPORTS_PER_SOL;
  
  let wsolBalance = 0;
  try {
    const wsolAccountInfo = await connection.getAccountInfo(wsolAccount);
    if (wsolAccountInfo) {
      const tokenAccountInfo = await getAccount(connection, wsolAccount);
      wsolBalance = Number(tokenAccountInfo.amount) / LAMPORTS_PER_SOL;
    } else {
      console.log('WSOL account does not exist yet');
    }
  } catch (error) {
    console.log('WSOL account does not exist yet');
  }
  
  console.log(`\n💰 Current Balances:`);
  console.log(`   Native SOL: ${nativeSOL.toFixed(6)}`);
  console.log(`   Wrapped SOL: ${wsolBalance.toFixed(6)}`);
  
  console.log('\n🔧 Available Operations:');
  console.log('  1. Wrap SOL → WSOL');
  console.log('  2. Unwrap WSOL → SOL');
  console.log('  3. Check balances only');
  console.log('  4. Back to main menu');
  
  const choice = await prompt('Select an operation (1-4): ');
  
  switch (choice.trim()) {
    case '1':
      const wrapAmountStr = await prompt('How much SOL to wrap? ');
      const wrapAmount = parseFloat(wrapAmountStr);
      
      if (wrapAmount <= 0 || isNaN(wrapAmount)) {
        console.log('❌ Invalid amount');
        break;
      }
      
      if (nativeSOL < wrapAmount + 0.01) {
        console.log(`❌ Insufficient SOL balance. Have: ${nativeSOL}, need: ${wrapAmount + 0.01}`);
        break;
      }
      
      try {
        await wrapSol(connection, admin, wrapAmount);
      } catch (error) {
        console.error('❌ Error wrapping SOL:', error);
      }
      break;
      
    case '2':
      if (wsolBalance === 0) {
        console.log('❌ No WSOL to unwrap');
        break;
      }
      
      try {
        await unwrapSol(connection, admin, wsolAccount);
      } catch (error) {
        console.error('❌ Error unwrapping SOL:', error);
      }
      break;
      
    case '3':
      console.log('✅ Balances displayed above');
      break;
      
    case '4':
      console.log('Returning to main menu...');
      break;
      
    default:
      console.log('❌ Invalid choice');
  }
  
  await waitForEnter();
}

async function main() {
  console.log('🚀 Starting Manifest Trading CLI...');
  
  while (true) {
    displayMenu();
    
    const choice = await prompt('Select an action (1-12): ');
    
    switch (choice.trim()) {
      case '1':
        await airdrop();
        break;
      case '2':
        await createMarket();
        break;
      case '3':
        await delegateMarket();
        break;
      case '4':
        await commitMarket();
        break;
      case '5':
        await claimSeat();
        break;
      case '6':
        await setupTokenAccounts();
        break;
      case '7':
        await depositWithExternalTransfers();
        break;
      case '8':
        await placeOrders();
        break;
      case '9':
        await viewStateDetails();
        break;
      case '10':
        await fetchOrderbook();
        break;
      case '11':
        await manageSolWrapping();
        break;
      case '12':
        console.log('\n👋 Goodbye!');
        rl.close();
        process.exit(0);
        break;
      default:
        console.log('❌ Invalid choice. Please select 1-12.');
        await waitForEnter();
    }
  }
}

// Handle graceful exit
process.on('SIGINT', () => {
  console.log('\n👋 Goodbye!');
  rl.close();
  process.exit(0);
});

main().catch(error => {
  console.error('❌ Fatal error:', error);
  rl.close();
  process.exit(1);
}); 
