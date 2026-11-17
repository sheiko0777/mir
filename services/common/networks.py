"""Network and deployment constants for read-only services. No credentials.

Chain IDs and addresses here are inputs to verify, not facts to trust: every
service must check the chain ID against the RPC it talks to before use.
"""

from dataclasses import dataclass
from typing import Dict, Optional


@dataclass(frozen=True)
class Network:
    name: str
    chain_id: int
    native_asset: str
    explorer_api_url: Optional[str] = None


NETWORKS: Dict[str, Network] = {
    "ARC": Network("Arc Mainnet", 5042, "USDC", "https://explorer.arc.io/api/v2"),
    "ROBINHOOD": Network("Robinhood Chain", 13371, "ETH", "https://robinhoodchain.blockscout.com/api/v2"),
}

# Uniswap Liquidity Launchpad buyback-and-burn deployments (from the mir-bot
# research handoff, 2026-11-11). The Robinhood chain ID is unverified.
LAUNCHPAD: Dict[str, Dict[str, str]] = {
    "ARC": {
        "recipient": "0x5cEe9852d136833aE26c9E36a96fC02Cdfc9C40C",
        "fee_splitter": "0xE8113a9a9CddD6d13fe8A3E32eAA687e108C4616",
    },
    "ROBINHOOD": {
        "recipient": "0xa1ba4CC12654D2b188e3ba77dc86c75cA47f1A4e",
        "fee_splitter": "0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf",
    },
}
