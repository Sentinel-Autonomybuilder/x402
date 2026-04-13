import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';

describe('BlueVpnPayment', function () {
  const PRICE_PER_DAY = 33333n; // ~$0.033 USDC (6 decimals) → $1/month
  const INITIAL_BALANCE = 1_000_000_000n; // 1000 USDC

  async function deployFixture() {
    const [owner, agent, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const usdc = await MockERC20.deploy('USD Coin', 'USDC', 6);

    const BlueVpnPayment = await ethers.getContractFactory('BlueVpnPayment');
    const payment = await BlueVpnPayment.deploy(await usdc.getAddress(), PRICE_PER_DAY);

    await usdc.mint(agent.address, INITIAL_BALANCE);
    await usdc.connect(agent).approve(await payment.getAddress(), ethers.MaxUint256);

    return { payment, usdc, owner, agent, other };
  }

  describe('Deployment', function () {
    it('sets USDC address and price', async function () {
      const { payment, usdc } = await loadFixture(deployFixture);
      expect(await payment.usdc()).to.equal(await usdc.getAddress());
      expect(await payment.pricePerDay()).to.equal(PRICE_PER_DAY);
    });

    it('sets deployer as owner', async function () {
      const { payment, owner } = await loadFixture(deployFixture);
      expect(await payment.owner()).to.equal(owner.address);
    });

    it('reverts on zero price', async function () {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const usdc = await MockERC20.deploy('USD Coin', 'USDC', 6);
      const BlueVpnPayment = await ethers.getContractFactory('BlueVpnPayment');
      await expect(BlueVpnPayment.deploy(await usdc.getAddress(), 0)).to.be.revertedWithCustomError(BlueVpnPayment, 'ZeroPrice');
    });
  });

  describe('pay()', function () {
    it('transfers correct USDC for 30 days ($1)', async function () {
      const { payment, usdc, owner, agent } = await loadFixture(deployFixture);

      const days = 30n;
      const expectedCost = days * PRICE_PER_DAY; // 999,990 = ~$1.00

      const ownerBefore = await usdc.balanceOf(owner.address);
      await payment.connect(agent).pay('agent-123', days);
      const ownerAfter = await usdc.balanceOf(owner.address);

      expect(ownerAfter - ownerBefore).to.equal(expectedCost);
    });

    it('transfers correct USDC for 1 day ($0.033)', async function () {
      const { payment, usdc, owner, agent } = await loadFixture(deployFixture);

      const ownerBefore = await usdc.balanceOf(owner.address);
      await payment.connect(agent).pay('agent-1day', 1);
      const ownerAfter = await usdc.balanceOf(owner.address);

      expect(ownerAfter - ownerBefore).to.equal(PRICE_PER_DAY);
    });

    it('emits VpnPayment event with correct data', async function () {
      const { payment, agent } = await loadFixture(deployFixture);

      const days = 7n;
      const expectedAmount = days * PRICE_PER_DAY;

      await expect(payment.connect(agent).pay('agent-456', days))
        .to.emit(payment, 'VpnPayment')
        .withArgs(agent.address, 'agent-456', days, expectedAmount, (v: bigint) => v > 0n);
    });

    it('reverts on 0 days', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await expect(payment.connect(agent).pay('agent-1', 0)).to.be.revertedWithCustomError(payment, 'InvalidDuration');
    });

    it('reverts on > 365 days', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await expect(payment.connect(agent).pay('agent-1', 366)).to.be.revertedWithCustomError(payment, 'InvalidDuration');
    });

    it('reverts on empty agentId', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await expect(payment.connect(agent).pay('', 1)).to.be.revertedWithCustomError(payment, 'EmptyAgentId');
    });

    it('reverts when paused', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await payment.setPaused(true);
      await expect(payment.connect(agent).pay('agent-1', 1)).to.be.revertedWithCustomError(payment, 'ContractPaused');
    });

    it('reverts on insufficient USDC balance', async function () {
      const { payment, other } = await loadFixture(deployFixture);
      await expect(payment.connect(other).pay('agent-1', 1)).to.be.reverted;
    });

    it('handles max days (365 = 1 year)', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      // 365 * 33333 = 12,166,545 = ~$12.17 — agent has 1000 USDC
      await expect(payment.connect(agent).pay('agent-max', 365)).to.emit(payment, 'VpnPayment');
    });
  });

  describe('quote()', function () {
    it('returns correct cost for 30 days', async function () {
      const { payment } = await loadFixture(deployFixture);
      expect(await payment.quote(30)).to.equal(30n * PRICE_PER_DAY);
    });

    it('returns 0 for 0 days', async function () {
      const { payment } = await loadFixture(deployFixture);
      expect(await payment.quote(0)).to.equal(0n);
    });
  });

  describe('Admin', function () {
    it('owner can update price', async function () {
      const { payment } = await loadFixture(deployFixture);
      const newPrice = 50000n;
      await expect(payment.setPricePerDay(newPrice))
        .to.emit(payment, 'PriceUpdated')
        .withArgs(PRICE_PER_DAY, newPrice);
      expect(await payment.pricePerDay()).to.equal(newPrice);
    });

    it('owner cannot set price to zero', async function () {
      const { payment } = await loadFixture(deployFixture);
      await expect(payment.setPricePerDay(0)).to.be.revertedWithCustomError(payment, 'ZeroPrice');
    });

    it('non-owner cannot update price', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await expect(payment.connect(agent).setPricePerDay(1)).to.be.revertedWithCustomError(payment, 'OwnableUnauthorizedAccount');
    });

    it('owner can pause and unpause', async function () {
      const { payment } = await loadFixture(deployFixture);
      await payment.setPaused(true);
      expect(await payment.paused()).to.be.true;
      await payment.setPaused(false);
      expect(await payment.paused()).to.be.false;
    });
  });
});
