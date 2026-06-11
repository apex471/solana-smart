use anchor_lang::prelude::*;

declare_id!("2qy5bss2EBXiT7Bg2TZoNj6tBNBLKXafBM4s916C7dsD");

#[program]
pub mod solana_escrow {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        escrow_id: u64,
        amount: u64,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        escrow.depositor = ctx.accounts.depositor.key();
        escrow.beneficiary = ctx.accounts.beneficiary.key();
        escrow.admin = ctx.accounts.admin.key();
        escrow.amount = amount;
        escrow.escrow_id = escrow_id;
        escrow.released = false;
        escrow.refunded = false;

        // Perform the transfer from depositor to the escrow PDA (the escrow account holds the funds)
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        Ok(())
    }

    pub fn release(ctx: Context<Release>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        
        require!(!escrow.released, EscrowError::AlreadyReleased);
        require!(!escrow.refunded, EscrowError::AlreadyRefunded);

        escrow.released = true;

        // Transfer funds from the escrow PDA to the beneficiary
        let amount = escrow.amount;
        **ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.beneficiary.to_account_info().try_borrow_mut_lamports()? += amount;

        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;

        require!(!escrow.released, EscrowError::AlreadyReleased);
        require!(!escrow.refunded, EscrowError::AlreadyRefunded);

        escrow.refunded = true;

        // Transfer funds from the escrow PDA back to the depositor
        let amount = escrow.amount;
        **ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.depositor.to_account_info().try_borrow_mut_lamports()? += amount;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(escrow_id: u64, amount: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    
    /// CHECK: Safe as this is just the recipient key
    pub beneficiary: AccountInfo<'info>,
    
    /// CHECK: Safe as this is the admin/authority key that can release or refund
    pub admin: AccountInfo<'info>,

    #[account(
        init,
        payer = depositor,
        space = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1,
        seeds = [b"escrow", admin.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    pub admin: Signer<'info>,

    #[account(mut)]
    /// CHECK: Safe as funds are sent here
    pub beneficiary: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"escrow", admin.key().as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump,
        has_one = admin,
        has_one = beneficiary,
    )]
    pub escrow: Account<'info, EscrowState>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub admin: Signer<'info>,

    #[account(mut)]
    /// CHECK: Safe as funds are sent back here
    pub depositor: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"escrow", admin.key().as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump,
        has_one = admin,
        has_one = depositor,
    )]
    pub escrow: Account<'info, EscrowState>,
}

#[account]
pub struct EscrowState {
    pub depositor: Pubkey,
    pub beneficiary: Pubkey,
    pub admin: Pubkey,
    pub amount: u64,
    pub escrow_id: u64,
    pub released: bool,
    pub refunded: bool,
}

#[error_code]
pub enum EscrowError {
    #[msg("The escrow funds have already been released.")]
    AlreadyReleased,
    #[msg("The escrow funds have already been refunded.")]
    AlreadyRefunded,
}
