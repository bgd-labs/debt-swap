// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {PercentageMath} from '@aave/core-v3/contracts/protocol/libraries/math/PercentageMath.sol';
import {IPoolAddressesProvider} from '@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol';
import {IERC20Detailed} from '@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20Detailed.sol';
import {SafeERC20} from '@aave/core-v3/contracts/dependencies/openzeppelin/contracts/SafeERC20.sol';
import {SafeMath} from '@aave/core-v3/contracts/dependencies/openzeppelin/contracts/SafeMath.sol';
import {IParaSwapAugustusRegistry} from '../dependencies/paraswap/IParaSwapAugustusRegistry.sol';
import {BaseParaSwapAdapter} from './BaseParaSwapAdapter.sol';

/**
 * @title BaseParaSwapSellAdapter
 * @notice Implements logic for selling an asset using ParaSwap (exact-in swap)
 */
abstract contract BaseParaSwapSellAdapter is BaseParaSwapAdapter {
  using PercentageMath for uint256;
  using SafeMath for uint256;
  using SafeERC20 for IERC20Detailed;

  /// @notice The address of the Paraswap Augustus Registry
  IParaSwapAugustusRegistry public immutable AUGUSTUS_REGISTRY;

  /**
   * @dev Constructor
   * @param addressesProvider The address of the Aave PoolAddressesProvider contract
   * @param pool The address of the Aave Pool contract
   * @param augustusRegistry The address of the Paraswap AugustusRegistry contract
   */
  constructor(
    IPoolAddressesProvider addressesProvider,
    address pool,
    IParaSwapAugustusRegistry augustusRegistry
  ) BaseParaSwapAdapter(addressesProvider, pool) {
    // Do something on Augustus registry to check the right contract was passed
    require(!augustusRegistry.isValidAugustus(address(0)), 'Not a valid Augustus address');
    AUGUSTUS_REGISTRY = augustusRegistry;
  }

  /**
   * @dev Swaps a token for another using ParaSwap (exact in)
   * @dev In case the swap input is less than the designated amount to sell, the excess remains in the contract
   * @param fromAmountOffset Offset of fromAmount in Augustus calldata if it should be overwritten, otherwise 0
   * @param paraswapData Data for Paraswap Adapter
   * @param assetToSwapFrom The address of the asset to swap from
   * @param assetToSwapTo The address of the asset to swap to
   * @param amountToSwap The amount of asset to swap from
   * @param minAmountToReceive The minimum amount to receive
   * @return amountReceived The amount of asset bought
   */
  function _sellOnParaSwap(
    uint256 fromAmountOffset,
    bytes memory paraswapData,
    IERC20Detailed assetToSwapFrom,
    IERC20Detailed assetToSwapTo,
    uint256 amountToSwap,
    uint256 minAmountToReceive
  ) internal returns (uint256 amountReceived) {
    (bytes memory swapCalldata, address augustus) = abi.decode(paraswapData, (bytes, address));

    require(AUGUSTUS_REGISTRY.isValidAugustus(augustus), 'INVALID_AUGUSTUS');

    {
      uint256 fromAssetDecimals = _getDecimals(assetToSwapFrom);
      uint256 toAssetDecimals = _getDecimals(assetToSwapTo);

      uint256 fromAssetPrice = _getPrice(address(assetToSwapFrom));
      uint256 toAssetPrice = _getPrice(address(assetToSwapTo));

      uint256 expectedMinAmountOut = amountToSwap
        .mul(fromAssetPrice.mul(10 ** toAssetDecimals))
        .div(toAssetPrice.mul(10 ** fromAssetDecimals))
        .percentMul(PercentageMath.PERCENTAGE_FACTOR - MAX_SLIPPAGE_PERCENT);

      // Sanity check for `minAmountToReceive` to ensure it is within slippage bounds
      require(expectedMinAmountOut <= minAmountToReceive, 'MIN_AMOUNT_EXCEEDS_MAX_SLIPPAGE');
    }

    uint256 balanceBeforeAssetFrom = assetToSwapFrom.balanceOf(address(this));
    require(balanceBeforeAssetFrom >= amountToSwap, 'INSUFFICIENT_BALANCE_BEFORE_SWAP');
    uint256 balanceBeforeAssetTo = assetToSwapTo.balanceOf(address(this));

    assetToSwapFrom.safeApprove(augustus, amountToSwap);

    if (fromAmountOffset != 0) {
      // Ensure 256 bit (32 bytes) fromAmountOffset value is within bounds of the
      // calldata, not overlapping with the first 4 bytes (function selector).
      require(
        fromAmountOffset >= 4 && fromAmountOffset <= swapCalldata.length.sub(32),
        'FROM_AMOUNT_OFFSET_OUT_OF_RANGE'
      );
      // Overwrite the fromAmount with the correct amount for the swap.
      // In memory, swapCalldata consists of a 256 bit length field, followed by
      // the actual bytes data, that is why 32 is added to the byte offset.
      assembly {
        mstore(add(swapCalldata, add(fromAmountOffset, 32)), amountToSwap)
      }
    }
    (bool success, ) = augustus.call(swapCalldata);
    if (!success) {
      // Copy revert reason from call
      assembly {
        returndatacopy(0, 0, returndatasize())
        revert(0, returndatasize())
      }
    }

    // Reset allowance
    assetToSwapFrom.safeApprove(augustus, 0);

    require(
      assetToSwapFrom.balanceOf(address(this)) == balanceBeforeAssetFrom.sub(amountToSwap),
      'WRONG_BALANCE_AFTER_SWAP'
    );
    amountReceived = assetToSwapTo.balanceOf(address(this)).sub(balanceBeforeAssetTo);
    require(amountReceived >= minAmountToReceive, 'INSUFFICIENT_AMOUNT_RECEIVED');

    emit Swapped(address(assetToSwapFrom), address(assetToSwapTo), amountToSwap, amountReceived);
  }
}
