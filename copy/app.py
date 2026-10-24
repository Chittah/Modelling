"""Compatibility entry point for the Flask backend.

Run with ``python app.py``; implementation lives in the backend package.
"""
from backend.core import *
from backend.models import *
from backend.fitting import *
from backend.single_tm import *
from backend.flows import *
from backend import core as _core
from backend import fitting as _fitting
from backend import flows as _flows
from backend import models as _models
from backend import routes as _routes
from backend import single_tm as _single_tm
from backend.routes import *


def __getattr__(name):
    for module in (_routes, _core, _models, _single_tm, _fitting, _flows):
        if hasattr(module, name):
            return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
