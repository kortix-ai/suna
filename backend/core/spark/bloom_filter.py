import math
import hashlib
from typing import List, Set


class FunctionBloomFilter:
    """
    Probabilistic data structure for fast negative lookups.
    
    - False positives possible (may say "exists" when it doesn't)
    - False negatives impossible (if it says "doesn't exist", it's 100% accurate)
    - O(k) operations where k = number of hash functions (typically 3-5)
    - Memory efficient: ~1KB for 100 items at 1% false positive rate
    """
    
    def __init__(self, expected_size: int = 100, false_positive_rate: float = 0.01):
        self.expected_size = expected_size
        self.false_positive_rate = false_positive_rate
        
        self.size = self._calculate_size(expected_size, false_positive_rate)
        self.hash_count = self._calculate_hash_count(self.size, expected_size)
        
        self.bit_array = bytearray((self.size + 7) // 8)
        self.item_count = 0
    
    def _calculate_size(self, n: int, p: float) -> int:
        if n <= 0 or p <= 0 or p >= 1:
            return 1000
        return max(1, int(-(n * math.log(p)) / (math.log(2) ** 2)))
    
    def _calculate_hash_count(self, m: int, n: int) -> int:
        if n <= 0:
            return 3
        count = int((m / n) * math.log(2))
        return max(1, min(count, 10))
    
    def _get_bit(self, index: int) -> bool:
        byte_index = index // 8
        bit_index = index % 8
        return bool(self.bit_array[byte_index] & (1 << bit_index))
    
    def _set_bit(self, index: int):
        byte_index = index // 8
        bit_index = index % 8
        self.bit_array[byte_index] |= (1 << bit_index)
    
    def _hash(self, item: str, seed: int) -> int:
        h = hashlib.sha256(f"{item}:{seed}".encode()).digest()
        hash_val = int.from_bytes(h[:4], byteorder='big')
        return hash_val % self.size
    
    def add(self, function_name: str):
        for i in range(self.hash_count):
            index = self._hash(function_name, i)
            self._set_bit(index)
        self.item_count += 1
    
    def add_multiple(self, function_names: List[str]):
        for name in function_names:
            self.add(name)
    
    def might_exist(self, function_name: str) -> bool:
        for i in range(self.hash_count):
            index = self._hash(function_name, i)
            if not self._get_bit(index):
                return False
        return True
    
    def get_stats(self) -> dict:
        bits_set = sum(bin(byte).count('1') for byte in self.bit_array)
        fill_ratio = bits_set / self.size if self.size > 0 else 0
        
        if self.item_count > 0 and self.size > 0:
            estimated_fpr = (1 - math.exp(-self.hash_count * self.item_count / self.size)) ** self.hash_count
        else:
            estimated_fpr = 0
        
        return {
            'size_bits': self.size,
            'size_bytes': len(self.bit_array),
            'hash_count': self.hash_count,
            'items_added': self.item_count,
            'bits_set': bits_set,
            'fill_ratio': f"{fill_ratio * 100:.2f}%",
            'target_fpr': f"{self.false_positive_rate * 100:.2f}%",
            'estimated_fpr': f"{estimated_fpr * 100:.2f}%"
        }


def create_function_bloom_filter(function_names: Set[str]) -> FunctionBloomFilter:
    bloom = FunctionBloomFilter(
        expected_size=max(len(function_names), 100),
        false_positive_rate=0.01 
    )
    bloom.add_multiple(list(function_names))
    return bloom

