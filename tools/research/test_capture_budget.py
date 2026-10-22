from concurrent.futures import ThreadPoolExecutor
import unittest
from capture_budget import CaptureBudget


class CaptureBudgetTests(unittest.TestCase):
    def test_parallel_workers_share_one_limit(self):
        budget = CaptureBudget(max_requests=3)
        def attempt(_):
            try:
                budget.admit()
                budget.record({'status': 'attempted'})
                return True
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(attempt, range(50)))
        self.assertEqual(sum(results), 3)
        self.assertEqual(budget.requests, 3)
        self.assertEqual(len(budget.evidence), 3)

    def test_deadline_does_not_admit_more_requests(self):
        now = [0]
        budget = CaptureBudget(clock=lambda: now[0], max_seconds=5)
        budget.admit()
        now[0] = 6
        with self.assertRaises(ValueError): budget.admit()
        self.assertEqual(budget.requests, 1)


if __name__ == '__main__': unittest.main()
