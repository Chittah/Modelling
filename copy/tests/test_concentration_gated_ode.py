import unittest
from unittest.mock import patch

import numpy as np

import app as fitter
import backend.fitting as ode_fitter
import backend.routes as routes
import backend.single_tm as single_tm


class ConcentrationGatedOdeTests(unittest.TestCase):
    def test_ode_optimizer_has_numpy_in_its_module_scope(self):
        self.assertIs(ode_fitter.run_fitting.__globals__["np"], np)

    def setUp(self):
        self.params = np.zeros(22)
        self.params[17] = 2.0  # WcrH4
        self.params[18] = 3.0  # Wb
        self.params[19] = 4.0  # WcrG4
        self.state = np.zeros(11)
        self.state[0] = 2.0  # Yb_g
        self.state[2] = 2.0  # Tm0
        self.state[7] = 3.0  # Tm5 (3H4)
        self.state[8] = 3.0  # Tm6 (1G4)

    def rhs(self, tm_pct, yb_pct):
        ode_params = self.params[:19].tolist() + [
            self.params[19], tm_pct, yb_pct,
        ]
        return np.asarray(fitter.UCOdeModel.system(0.0, self.state, ode_params, 0.0))

    def test_cross_relaxation_uses_strict_tm_thresholds(self):
        below_g4 = self.rhs(0.1, 10.0)
        above_g4 = self.rhs(0.1001, 10.0)
        at_h4 = self.rhs(1.0, 10.0)
        above_h4 = self.rhs(1.0001, 10.0)

        self.assertEqual(below_g4[7], 0.0)
        self.assertEqual(above_g4[7], 24.0)
        self.assertEqual(at_h4[7], 24.0)
        self.assertEqual(above_h4[7], 12.0)

    def test_back_transfer_uses_strict_yb_threshold(self):
        at_threshold = self.rhs(0.5, 10.0)
        above_threshold = self.rhs(0.5, 10.0001)

        self.assertEqual(at_threshold[1], 0.0)
        self.assertEqual(above_threshold[1], 18.0)
        self.assertEqual(at_threshold[7] - above_threshold[7], 18.0)

    def test_enabled_transfer_reactions_conserve_total_population(self):
        for tm_pct, yb_pct in (
            (0.1001, 10.0),
            (1.0001, 10.0),
            (0.5, 10.0001),
        ):
            with self.subTest(tm_pct=tm_pct, yb_pct=yb_pct):
                self.assertAlmostEqual(float(np.sum(self.rhs(tm_pct, yb_pct))), 0.0)

    def test_inactive_gate_parameters_are_not_reported_as_fit_parameters(self):
        roles = fitter.classify_parameter_roles(7, doping_yb=10.0, doping_tm=0.1)
        reported = set().union(
            roles["direct"],
            roles["indirect"],
            roles["weakly_identifiable"],
        )
        self.assertTrue({"WcrG4", "WcrH4", "Wb"}.isdisjoint(reported))

    def test_775_population_is_fed_through_tm3_by_k35(self):
        params = np.zeros(22)
        params[3] = 3.0  # W2
        params[8] = 4.0  # k35
        state = np.zeros(11)
        state[1] = 2.0  # Yb_e
        state[3] = 5.0  # Tm1
        state[5] = 7.0  # Tm3

        derivative = fitter.UCOdeModel.system(
            0.0,
            state,
            params[:19].tolist() + [params[19], 0.1, 10.0],
            0.0,
        )

        self.assertEqual(derivative[5], 2.0)  # W2*Yb_e*Tm1 - k35*Tm3
        self.assertEqual(derivative[7], 28.0)  # k35*Tm3; no direct W2 feed
        roles = fitter.classify_parameter_roles(7, doping_yb=10.0, doping_tm=0.1)
        self.assertTrue({"W2", "k35"}.issubset(set(roles["direct"])))


class ExistingFitPathRegressionTests(unittest.TestCase):
    def test_direct_tm_ode_accepts_the_listed_excitation_emission_pairs(self):
        self.assertEqual(
            fitter._ST_ALLOWED_EMISSIONS,
            {260: {"346"}, 356: {"454", "775"}, 466: {"645"}},
        )

    def test_single_tm_yb_loss_is_limited_to_h4_and_g4_and_conserves_tm(self):
        p = np.zeros(18)
        p[17] = 2.0  # Kyb
        y = np.array([1.0, 0.0, 3.0, 4.0, 2.0, 1.0, 0.5])
        without_yb = np.asarray(
            fitter._st_rhs(0.0, y, p, False, 0, None, 0.5, 0.0),
        )
        with_yb = np.asarray(
            fitter._st_rhs(0.0, y, p, False, 0, None, 0.5, 10.0),
        )

        np.testing.assert_allclose(with_yb - without_yb, [140.0, 0.0, -60.0, -80.0, 0.0, 0.0, 0.0])
        self.assertAlmostEqual(float(np.sum(with_yb - without_yb)), 0.0)

    def test_direct_tm_fit_passes_optional_yb_concentration_to_ode(self):
        fit_result = (
            np.array([0.0, 1.0, 0.5, 0.1]),
            {"G": 20.0, "T_offset": 0.0},
            0.0,
            {
                "tolerance_achieved": {"peak": 0.0, "rise": 0.0, "decay": 0.0},
                "tolerance_targets": {"peak": 0.01, "rise": 0.1, "decay": 0.1},
                "active_params": [],
                "fit_quality": "accurate",
                "optimize_all_points": False,
            },
        )
        payload = {
            "excitation_wavelength": 356,
            "emission": "775",
            "doping_tm": 0.5,
            "doping_yb": 10.0,
            "time": [0.0, 1.0, 2.0, 3.0],
            "intensity": [0.0, 1.0, 0.5, 0.1],
            "time_unit": "ms",
            "pulse_width_us": 400,
            "fit_quality": "accurate",
        }

        with fitter.app.test_request_context("/fit"), patch.object(
            single_tm, "run_fitting_single_tm", return_value=fit_result,
        ) as run_fit, patch.object(single_tm, "compute_trace_metrics", return_value={}), patch.object(
            single_tm, "update_fit_progress",
        ):
            response = single_tm._fit_single_tm_route(payload, None, 0.0)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(run_fit.call_args.args[6], 10.0)

    def test_single_doped_tm_rate_equations_remain_separate(self):
        p = np.zeros(18)
        p[16] = 2.0  # Kcr
        p[17] = 3.0  # Kyb
        y = np.array([1.0, 0.0, 2.0, 4.0, 3.0, 0.0, 0.0])

        derivative = fitter._st_rhs(
            0.0, y, p, False, ie=0, ie_esa=None, tm_pct=0.5, yb_pct=4.0,
        )

        np.testing.assert_allclose(
            derivative,
            [67.0, 7.0, -26.0, -45.0, -3.0, 0.0, 0.0],
        )

    def test_single_tm_kcr_changes_only_h4_d2_and_their_cr_products(self):
        p = np.zeros(18)
        p[16] = 2.0  # Kcr
        y = np.array([1.0, 0.0, 2.0, 0.0, 3.0, 4.0, 5.0])

        with_cr = np.asarray(
            fitter._st_rhs(0.0, y, p, False, 0, None, 0.5, 0.0),
        )
        p[16] = 0.0
        without_cr = np.asarray(
            fitter._st_rhs(0.0, y, p, False, 0, None, 0.5, 0.0),
        )

        np.testing.assert_allclose(
            with_cr - without_cr,
            [-5.0, 7.0, -2.0, 3.0, -3.0, 0.0, 0.0],
        )
        self.assertAlmostEqual(float(np.sum(with_cr - without_cr)), 0.0)

    def test_single_tm_kyb_loss_does_not_act_on_i6_or_p2(self):
        p = np.zeros(18)
        p[17] = 2.0  # Kyb
        y = np.array([1.0, 0.0, 3.0, 4.0, 2.0, 5.0, 6.0])

        without_yb = np.asarray(
            fitter._st_rhs(0.0, y, p, False, 0, None, 0.5, 0.0),
        )
        with_yb = np.asarray(
            fitter._st_rhs(0.0, y, p, False, 0, None, 0.5, 10.0),
        )

        np.testing.assert_allclose(with_yb - without_yb, [140.0, 0.0, -60.0, -80.0, 0.0, 0.0, 0.0])

    def test_single_tm_i6_observable_uses_a71_while_a70_is_a_competing_decay_branch(self):
        self.assertEqual(fitter._ST_OBS["346"], ("I6", "A71"))
        self.assertIn("A70", fitter._ST_LEVEL_PARAMS["I6"])

        p = np.zeros(18)
        p[11] = 2.0  # A70: I6 -> H6
        p[12] = 3.0  # A71: I6 -> F4
        y = np.array([0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0])
        derivative = np.asarray(
            fitter._st_rhs(0.0, y, p, False, 0, None, 0.0, 0.0),
        )

        np.testing.assert_allclose(derivative, [2.0, 3.0, 0.0, 0.0, 0.0, -5.0, 0.0])

    def test_single_tm_ground_pump_g_moves_population_to_excitation_entry_only_when_on(self):
        p = np.zeros(18)
        p[0] = 7.0  # G
        y = np.array([1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])

        pump_on = np.asarray(
            fitter._st_rhs(0.0, y, p, True, 6, None, 0.0, 0.0),
        )
        pump_off = np.asarray(
            fitter._st_rhs(0.0, y, p, False, 6, None, 0.0, 0.0),
        )

        np.testing.assert_allclose(pump_on, [-7.0, 0.0, 0.0, 0.0, 0.0, 0.0, 7.0])
        np.testing.assert_allclose(pump_off, np.zeros(7))

    def test_single_tm_fit_does_not_free_cr_or_yb_rates_for_i6_emission(self):
        excitation = fitter._ST_EXCITATION[260]
        active = set(fitter._st_active_names(excitation, "I6", 1.0, 10.0, False))

        self.assertIn("G", active)
        self.assertIn("A70", active)
        self.assertIn("A71", active)
        self.assertNotIn("Kcr", active)
        self.assertNotIn("Kyb", active)

    def test_single_tm_fit_frees_cr_and_yb_rates_only_on_affected_emission_paths(self):
        excitation = fitter._ST_EXCITATION[260]

        i6_active = set(fitter._st_active_names(excitation, "I6", 1.0, 10.0, False))
        d2_active = set(fitter._st_active_names(excitation, "D2", 1.0, 0.0, False))
        g4_active = set(fitter._st_active_names(excitation, "G4", 0.5, 10.0, False))

        self.assertNotIn("Kcr", i6_active)
        self.assertIn("Kcr", d2_active)
        self.assertNotIn("Kyb", d2_active)
        self.assertIn("Kcr", g4_active)
        self.assertIn("Kyb", g4_active)

    def test_single_doped_fit_request_keeps_its_dedicated_route(self):
        with fitter.app.test_client() as client, patch.object(
            routes, "_fit_single_tm_route",
            return_value={"pipeline": "single-tm"},
        ) as single_tm_route, patch.object(routes, "run_fitting") as ode_fit:
            response = client.post("/fit", json={"material_model": "single_doped_tm"})

        self.assertEqual(response.get_json(), {"pipeline": "single-tm"})
        single_tm_route.assert_called_once()
        ode_fit.assert_not_called()

    def test_etuc_fit_request_keeps_the_existing_ode_optimizer_route(self):
        old_configured = fitter.physics_state["configured"]
        old_time_scale = fitter.physics_state["time_scale"]
        fitter.physics_state.update(configured=True, time_scale=1.0)
        try:
            with fitter.app.test_client() as client, patch.object(
                routes, "run_fitting", side_effect=RuntimeError("ODE optimizer reached"),
            ) as ode_fit:
                response = client.post("/fit", json={
                    "luminescence_type": "upconversion",
                    "upconversion_mechanism": "etuc",
                    "material_model": "co_doped_yb_tm",
                    "time": [0.0, 1.0, 2.0],
                    "intensity": [0.0, 1.0, 0.2],
                    "doping_yb": 12.0,
                    "doping_tm": 0.5,
                    "emission": "775",
                    "try_best_match": False,
                })
        finally:
            fitter.physics_state.update(
                configured=old_configured,
                time_scale=old_time_scale,
            )

        self.assertEqual(response.status_code, 500)
        ode_fit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
