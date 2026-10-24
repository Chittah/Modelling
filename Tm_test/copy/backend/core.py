import os

# ── Force single-threaded BLAS/LAPACK BEFORE numpy is imported ──────────────
# Radau uses implicit Jacobian solves via BLAS.  With multiple threads the
# floating-point reduction order is non-deterministic, which causes different
# adaptive step sizes to be chosen on every run → zero reproducibility.
os.environ.setdefault("OMP_NUM_THREADS",      "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS",      "1")
os.environ.setdefault("BLIS_NUM_THREADS",     "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
# ────────────────────────────────────────────────────────────────────────────

from flask import Flask, jsonify, request, send_from_directory
import numpy as np
import traceback
import time
import threading
from scipy.optimize import differential_evolution, least_squares
from scipy.integrate import solve_ivp

from flask import Response


# =============================================================================
# SECTION 1 – APP SETUP & GLOBAL STATE
# =============================================================================

# Initialize Flask with your static folder settings
APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = Flask(__name__, static_folder=APP_ROOT, static_url_path="")
os.makedirs(os.path.join(APP_ROOT, "static", "plots"), exist_ok=True)

# Global configuration to match your website settings panel
physics_state = {
    "configured": False,
    "doping_yb": 10.0,
    "doping_tm": 0.1,
    "time_scale": 1e-6,
    "model_type": "LINEAR_UC_MODEL",
    "time_unit": "ns",
    "fit_quality": "fast"
}

fit_cancel_flags = {}
fit_cancel_lock = threading.Lock()
fit_progress_state = {}
fit_progress_lock = threading.Lock()


# =============================================================================
# SECTION 2 – FIT CANCEL & PROGRESS TRACKING
# =============================================================================

class FitCancelled(Exception):
    """Raised when user cancels an in-flight fit."""


def register_fit_request(fit_request_id):
    if not fit_request_id:
        return
    with fit_cancel_lock:
        fit_cancel_flags[fit_request_id] = False


def cancel_fit_request(fit_request_id):
    if not fit_request_id:
        return
    with fit_cancel_lock:
        fit_cancel_flags[fit_request_id] = True


def is_fit_cancelled(fit_request_id):
    if not fit_request_id:
        return False
    with fit_cancel_lock:
        return bool(fit_cancel_flags.get(fit_request_id, False))


def clear_fit_request(fit_request_id):
    if not fit_request_id:
        return
    with fit_cancel_lock:
        fit_cancel_flags.pop(fit_request_id, None)


def init_fit_progress(fit_request_id):
    if not fit_request_id:
        return
    with fit_progress_lock:
        fit_progress_state[fit_request_id] = {
            "seq": 0,
            "status": "running",
            "message": "Fit request received.",
            "updated_at": time.time(),
        }


def update_fit_progress(fit_request_id, **fields):
    if not fit_request_id:
        return
    with fit_progress_lock:
        state = fit_progress_state.get(fit_request_id, {
            "seq": 0,
            "status": "running",
            "message": "",
            "updated_at": time.time(),
        })
        state["seq"] = int(state.get("seq", 0)) + 1
        state.update(fields)
        state["updated_at"] = time.time()
        fit_progress_state[fit_request_id] = state


def get_fit_progress(fit_request_id):
    if not fit_request_id:
        return None
    with fit_progress_lock:
        state = fit_progress_state.get(fit_request_id)
        return dict(state) if state else None


def clear_fit_progress(fit_request_id):
    if not fit_request_id:
        return
    with fit_progress_lock:
        fit_progress_state.pop(fit_request_id, None)


# =============================================================================
