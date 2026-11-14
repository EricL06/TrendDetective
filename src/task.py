from abc import ABC, abstractmethod
from dataclasses import dataclass

import torch


class Task(ABC):
    """Abstract class for tasks"""

    @abstractmethod
    def process(self, X: torch.Tensor, y: torch.Tensor):
        """Process given data."""

class LinearRegression(Task):
    """Linear regression task."""

    def process(self, X: torch.Tensor, y: torch.Tensor):
        """Return tuple of weight and bias for linear regression model for given dataset."""
        X_b = torch.cat([X, torch.ones(X.shape[0], 1)], dim=1)
        solution = torch.linalg.lstsq(X_b, y).solution
        w = solution[0]
        b = solution[1]
        return (w, b)
