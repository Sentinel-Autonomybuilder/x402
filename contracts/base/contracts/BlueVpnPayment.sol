// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BlueVpnPayment
 * @notice AI agents pay USDC for time-based VPN access.
 *         Agent registers off-chain first (gets agentId), then calls pay().
 *         Our backend watches VpnPayment events and provisions Sentinel access.
 *         Pricing: per-day, minimum 1 day, maximum 365 days.
 */
contract BlueVpnPayment is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    uint256 public pricePerDay;
    bool public paused;

    event VpnPayment(
        address indexed sender,
        string agentId,
        uint256 numDays,
        uint256 amount,
        uint256 timestamp
    );

    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event Paused(bool state);

    error InvalidDuration();
    error EmptyAgentId();
    error ContractPaused();
    error ZeroPrice();

    constructor(address _usdc, uint256 _pricePerDay) Ownable(msg.sender) {
        if (_pricePerDay == 0) revert ZeroPrice();
        usdc = IERC20(_usdc);
        pricePerDay = _pricePerDay;
    }

    /**
     * @notice Pay for VPN access. Agent must have approved USDC spend first.
     * @param agentId The agent's registration ID from our API (NOT sentinel address)
     * @param numDays Number of days to purchase (1 - 365)
     */
    function pay(string calldata agentId, uint256 numDays) external {
        if (paused) revert ContractPaused();
        if (numDays == 0 || numDays > 365) revert InvalidDuration();
        if (bytes(agentId).length == 0) revert EmptyAgentId();

        uint256 amount = numDays * pricePerDay;
        usdc.safeTransferFrom(msg.sender, owner(), amount);

        emit VpnPayment(msg.sender, agentId, numDays, amount, block.timestamp);
    }

    /**
     * @notice Calculate cost for a given number of days
     * @param numDays Number of days
     * @return USDC amount in atomic units (6 decimals)
     */
    function quote(uint256 numDays) external view returns (uint256) {
        return numDays * pricePerDay;
    }

    // ─── Admin ───

    function setPricePerDay(uint256 _price) external onlyOwner {
        if (_price == 0) revert ZeroPrice();
        emit PriceUpdated(pricePerDay, _price);
        pricePerDay = _price;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }
}
