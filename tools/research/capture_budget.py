"""One shared admission budget across all public capture workers."""
import threading
import time


class CaptureBudget:
    def __init__(self, max_requests=20, max_seconds=180, clock=time.monotonic):
        self.max_requests, self.max_seconds = max_requests, max_seconds
        self.clock, self.started = clock, clock()
        self.requests, self.evidence = 0, []
        self.lock = threading.Lock()

    def admit(self):
        with self.lock:
            if self.requests >= self.max_requests or self.clock() - self.started > self.max_seconds:
                raise ValueError('Public capture budget exhausted')
            self.requests += 1

    def record(self, evidence):
        with self.lock:
            self.evidence.append(evidence)
