import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaEscrow } from "../target/types/solana_escrow";
import { expect } from "chai";

describe("solana-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaEscrow as Program<SolanaEscrow>;

  const admin = anchor.web3.Keypair.generate();
  const depositor = anchor.web3.Keypair.generate();
  const beneficiary = anchor.web3.Keypair.generate();

  // Airdrop SOL to depositor and admin so they can pay for transactions and rent
  before(async () => {
    const signature1 = await provider.connection.requestAirdrop(
      depositor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature1);

    const signature2 = await provider.connection.requestAirdrop(
      admin.publicKey,
      1 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature2);
  });

  it("Initializes the escrow and deposits funds", async () => {
    const escrowId = new anchor.BN(12345);
    const depositAmount = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL);

    // Derive PDA for the escrow
    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        admin.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Get balances before
    const depositorBalanceBefore = await provider.connection.getBalance(depositor.publicKey);

    // Call initialize
    await program.methods
      .initialize(escrowId, depositAmount)
      .accounts({
        depositor: depositor.publicKey,
        beneficiary: beneficiary.publicKey,
        admin: admin.publicKey,
        escrow: escrowPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    // Verify escrow account state
    const escrowState = await program.account.escrowState.fetch(escrowPda);
    expect(escrowState.depositor.toString()).to.equal(depositor.publicKey.toString());
    expect(escrowState.beneficiary.toString()).to.equal(beneficiary.publicKey.toString());
    expect(escrowState.admin.toString()).to.equal(admin.publicKey.toString());
    expect(escrowState.amount.toString()).to.equal(depositAmount.toString());
    expect(escrowState.escrowId.toString()).to.equal(escrowId.toString());
    expect(escrowState.released).to.be.false;
    expect(escrowState.refunded).to.be.false;

    // Verify escrow PDA balance
    const escrowBalance = await provider.connection.getBalance(escrowPda);
    expect(escrowBalance).to.be.at.least(depositAmount.toNumber());

    // Verify depositor balance decreased
    const depositorBalanceAfter = await provider.connection.getBalance(depositor.publicKey);
    expect(depositorBalanceBefore - depositorBalanceAfter).to.be.at.least(depositAmount.toNumber());
  });

  it("Releases funds to beneficiary by admin", async () => {
    const escrowId = new anchor.BN(12345);
    const depositAmount = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL);

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        admin.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const beneficiaryBalanceBefore = await provider.connection.getBalance(beneficiary.publicKey);

    // Call release
    await program.methods
      .release()
      .accounts({
        admin: admin.publicKey,
        beneficiary: beneficiary.publicKey,
        escrow: escrowPda,
      })
      .signers([admin])
      .rpc();

    // Verify beneficiary balance increased
    const beneficiaryBalanceAfter = await provider.connection.getBalance(beneficiary.publicKey);
    expect(beneficiaryBalanceAfter - beneficiaryBalanceBefore).to.equal(depositAmount.toNumber());

    // Verify state updated
    const escrowState = await program.account.escrowState.fetch(escrowPda);
    expect(escrowState.released).to.be.true;
  });

  it("Refunds funds to depositor by admin", async () => {
    const escrowId = new anchor.BN(67890); // New escrow ID
    const depositAmount = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL);
    const freshDepositor = anchor.web3.Keypair.generate();

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        admin.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Request an airdrop for freshDepositor so it has enough funds
    const airdropSignature = await provider.connection.requestAirdrop(
      freshDepositor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSignature);

    // Initialize the new escrow
    await program.methods
      .initialize(escrowId, depositAmount)
      .accounts({
        depositor: freshDepositor.publicKey,
        beneficiary: beneficiary.publicKey,
        admin: admin.publicKey,
        escrow: escrowPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([freshDepositor])
      .rpc();

    const depositorBalanceBefore = await provider.connection.getBalance(freshDepositor.publicKey);

    // Call refund
    await program.methods
      .refund()
      .accounts({
        admin: admin.publicKey,
        depositor: freshDepositor.publicKey,
        escrow: escrowPda,
      })
      .signers([admin])
      .rpc();

    // Verify depositor balance increased
    const depositorBalanceAfter = await provider.connection.getBalance(freshDepositor.publicKey);
    expect(depositorBalanceAfter - depositorBalanceBefore).to.equal(depositAmount.toNumber());

    // Verify state updated
    const escrowState = await program.account.escrowState.fetch(escrowPda);
    expect(escrowState.refunded).to.be.true;
  });
});
