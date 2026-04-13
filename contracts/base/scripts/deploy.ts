import { ethers, network } from 'hardhat';

const USDC_ADDRESSES: Record<string, string> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  baseSepolia: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

async function main() {
  const networkName = network.name;
  const usdcAddress = USDC_ADDRESSES[networkName];

  if (!usdcAddress) {
    throw new Error(`No USDC address for network: ${networkName}. Use base or baseSepolia.`);
  }

  const pricePerDay = process.env.PRICE_PER_DAY || '33333'; // $0.033/day → $1/month

  console.log(`Deploying BlueVpnPayment on ${networkName}`);
  console.log(`  USDC: ${usdcAddress}`);
  console.log(`  Price per day: ${pricePerDay} (${Number(pricePerDay) / 1e6} USDC)`);
  console.log(`  Monthly cost: $${(Number(pricePerDay) * 30 / 1e6).toFixed(2)}`);

  const BlueVpnPayment = await ethers.getContractFactory('BlueVpnPayment');
  const payment = await BlueVpnPayment.deploy(usdcAddress, pricePerDay);
  await payment.waitForDeployment();

  const address = await payment.getAddress();
  console.log(`\nBlueVpnPayment deployed to: ${address}`);

  // Wait a moment for chain to settle before reading state
  await new Promise(r => setTimeout(r, 3000));

  try {
    console.log(`Owner: ${await payment.owner()}`);
    console.log(`Price per day: ${await payment.pricePerDay()}`);
    console.log(`30-day quote: ${ethers.formatUnits(await payment.quote(30), 6)} USDC`);
  } catch {
    console.log('(State reads pending — contract is deployed, verify on explorer)');
  }

  console.log(`\nAdd to .env: PAYMENT_CONTRACT_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
