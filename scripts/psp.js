const {
  constructSimpleSDK,
  SwapSide,
  ContractMethod,
} = require("@paraswap/sdk");
const axios = require("axios");
const { BigNumber } = require("ethers");
const { defaultAbiCoder } = require("ethers/lib/utils");
const objectHash = require("object-hash");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

const CHAIN_ID = args[0];
const FROM = args[1];
const TO = args[2];
const AMOUNT = args[3];
const USER_ADDRESS = args[4];
const METHOD = args[5];
const MAX_SLIPPAGE = Number(args[6]);
const MAX = args[7] === "true";
const FROM_DECIMALS = Number(args[8]);
const TO_DECIMALS = Number(args[9]);
// param only needed for the hash
// const BLOCK_NUMBER = Number(args[10]);

// generate a hash for input parameters to cache response and not spam psp sdk
const hash = objectHash(args);

const paraSwapMin = constructSimpleSDK({
  chainId: CHAIN_ID,
  axios,
});

// https://github.com/aave/aave-utilities/blob/master/packages/contract-helpers/src/paraswap-liquiditySwapAdapter-contract/index.ts#L19
function augustusFromAmountOffsetFromCalldata(calldata) {
  switch (calldata.slice(0, 10)) {
    case "0xda8567c8": // Augustus V3 multiSwap
      return 100; // 4 + 3 * 32
    case "0x58b9d179": // Augustus V4 swapOnUniswap
      return 4; // 4 + 0 * 32
    case "0x0863b7ac": // Augustus V4 swapOnUniswapFork
      return 68; // 4 + 2 * 32
    case "0x8f00eccb": // Augustus V4 multiSwap
      return 68; // 4 + 2 * 32
    case "0xec1d21dd": // Augustus V4 megaSwap
      return 68; // 4 + 2 * 32
    case "0x54840d1a": // Augustus V5 swapOnUniswap
      return 4; // 4 + 0 * 32
    case "0xf5661034": // Augustus V5 swapOnUniswapFork
      return 68; // 4 + 2 * 32
    case "0x0b86a4c1": // Augustus V5 swapOnUniswapV2Fork
      return 36; // 4 + 1 * 32
    case "0x64466805": // Augustus V5 swapOnZeroXv4
      return 68; // 4 + 2 * 32
    case "0xa94e78ef": // Augustus V5 multiSwap
      return 68; // 4 + 2 * 32
    case "0x46c67b6d": // Augustus V5 megaSwap
      return 68; // 4 + 2 * 32
    case "0xb22f4db8": // Augustus V5 directBalancerV2GivenInSwap
      return 68; // 4 + 2 * 32
    case "0x19fc5be0": // Augustus V5 directBalancerV2GivenOutSwap
      return 68; // 4 + 2 * 32
    case "0x3865bde6": // Augustus V5 directCurveV1Swap
      return 68; // 4 + 2 * 32
    case "0x58f15100": // Augustus V5 directCurveV2Swap
      return 68; // 4 + 2 * 32
    case "0xa6866da9": // Augustus V5 directUniV3Swap
      return 68; // 4 + 2 * 32
    case "0xe3ead59e": // Augustus V6 swapExactAmountIn
      return 100; // 4 + 3 * 32
    case "0xd85ca173": // Augustus V6 swapExactAmountInOnBalancerV2
      return 4; // 4 + 0 * 32
    case "0x1a01c532": // Augustus V6 swapExactAmountInOnCurveV1
      return 132; // 4 + 4 * 32
    case "0xe37ed256": // Augustus V6 swapExactAmountInOnCurveV2
      return 196; // 4 + 6 * 32
    case "0xe8bb3b6c": // Augustus V6 swapExactAmountInOnUniswapV2
      return 164; // 4 + 4 * 32
    case "0x876a02f6": // Augustus V6 swapExactAmountInOnUniswapV3
      return 164; // 4 + 4 * 32
    case "0x987e7d8e": // Augustus V6 swapExactAmountInOutOnMakerPSM
    default:
      throw new Error("Unrecognized function selector for Augustus");
  }
}

// https://github.com/aave/aave-utilities/blob/be742e5a8bfa1ed3859aaa9bc101ce807820f467/packages/contract-helpers/src/commons/utils.ts#L149
const augustusToAmountOffsetFromCalldata = (calldata) => {
  switch (calldata.slice(0, 10)) {
    case "0x935fb84b": // Augustus V5 buyOnUniswap
      return 36; // 4 + 1 * 32
    case "0xc03786b0": // Augustus V5 buyOnUniswapFork
      return 100; // 4 + 3 * 32
    case "0xb2f1e6db": // Augustus V5 buyOnUniswapV2Fork
      return 68; // 4 + 2 * 32
    case "0xb66bcbac": // Augustus V5 buy (old)
    case "0x35326910": // Augustus V5 buy
      return 164; // 4 + 5 * 32
    case "0x87a63926": // Augustus V5 directUniV3Buy
      return 68; // 4 + 2 * 32
    case "0x7f457675": // Augustus V6 swapExactAmountOut
      return 132; // 4 + 4 * 32
    case "0xd6ed22e6": // Augustus V6 swapExactAmountOutOnBalancerV2
      return 36; // 4 + 1 * 32
    case "0xa76f4eb6": // Augustus V6 swapExactAmountOutOnUniswapV2
      return 196; // 4 + 6 * 32
    case "0x5e94e28d": // Augustus V6 swapExactAmountOutOnUniswapV3
      return 196; // 4 + 6 * 32
    case "0x987e7d8e": // Augustus V6 swapExactAmountInOutOnMakerPSM
      return 100; // 4 + 3 * 32
    default:
      throw new Error("Unrecognized function selector for Augustus");
  }
};

async function main(from, to, method, amount, user) {
  // check cache and return cache if available
  const filePath = path.join(process.cwd(), "tests/pspcache", hash);
  if (fs.existsSync(filePath)) {
    const file = fs.readFileSync(filePath);
    process.stdout.write(file);
    return;
  }
  // distinguish between exactOut and exactInoutdMethod
  const includedMethods =
    method === "SELL"
      ? [ContractMethod.swapExactAmountIn]
      : [ContractMethod.swapExactAmountOut];
  const priceRoute = await paraSwapMin.swap.getRate({
    srcToken: from,
    srcDecimals: FROM_DECIMALS,
    destToken: to,
    destDecimals: TO_DECIMALS,
    amount: amount,
    side: method,
    ...(MAX
      ? {
          options: {
            includeContractMethods: [...includedMethods],
          },
        }
      : {}),
  });

  // add slippage on non exact side of the swap
  const srcAmount =
    METHOD === SwapSide.SELL
      ? priceRoute.srcAmount
      : BigNumber.from(priceRoute.srcAmount)
          .mul(100 + MAX_SLIPPAGE)
          .div(100)
          .toString();
  const destAmount =
    METHOD === SwapSide.SELL
      ? BigNumber.from(priceRoute.destAmount)
          .mul(100 - MAX_SLIPPAGE)
          .div(100)
          .toString()
      : priceRoute.destAmount;

  const txParams = await paraSwapMin.swap.buildTx(
    {
      srcToken: from,
      srcDecimals: FROM_DECIMALS,
      destToken: to,
      destDecimals: TO_DECIMALS,
      srcAmount,
      destAmount,
      priceRoute,
      userAddress: user,
      partner: "aave",
    },
    { ignoreChecks: true }
  );
  const offset = MAX
    ? method === "SELL"
      ? augustusFromAmountOffsetFromCalldata(txParams.data)
      : augustusToAmountOffsetFromCalldata(txParams.data)
    : 0;

  const encodedData = defaultAbiCoder.encode(
    ["(address,bytes,uint256,uint256,uint256)"],
    [[txParams.to, txParams.data, srcAmount, destAmount, offset]]
  );

  fs.writeFileSync(filePath, encodedData);
  process.stdout.write(encodedData);
}
main(FROM, TO, METHOD, AMOUNT, USER_ADDRESS);
