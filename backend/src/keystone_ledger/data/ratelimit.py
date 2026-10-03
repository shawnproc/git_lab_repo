"""Self-imposed request pacing so we stay far below any provider's limit."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable


class MinIntervalLimiter:
    """Blocks so consecutive calls are at least `1 / rate` seconds apart (thread-safe)."""

    def __init__(
        self,
        rate_per_s: float,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if rate_per_s <= 0:
            raise ValueError("rate must be positive")
        self.interval = 1.0 / rate_per_s
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = self._clock()
            if now < self._next:
                self._sleep(self._next - now)
                now = self._next
            self._next = now + self.interval
