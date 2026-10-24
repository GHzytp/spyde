"""Rebin: which factor bins which axis, and what the crosshair reads afterwards.

Two reports from using it on a 4-D scan:

* the caret listed the detector factors before the scan ones, the reverse of
  the order every 4-D dataset is described in (scan x, scan y, diffraction x,
  diffraction y);
* after binning the scan, the pattern shown no longer matched the crosshair.
  The navigator keeps showing the unbinned scan, so its crosshair speaks in
  unbinned positions, and those were used as positions of the binned node:
  scan column 6 of a scan binned by 2 read binned column 6, which holds scan
  columns 12 and 13, and anything past the binned width clamped to its edge.

The data here is non-square and every frame names the position it came from,
so a swapped or mis-scaled axis shows up as a wrong number rather than as a
plausible-looking pattern.
"""
from __future__ import annotations

import dask.array as da
import hyperspy.api as hs
import numpy as np
import pytest

from spyde.tests.migrated.conftest import close_session, make_session

SCAN_ROWS, SCAN_COLUMNS, DETECTOR = 6, 10, 4


def _named_frames():
    """Frame (row, column) carries 100 * row + column at detector (0, 0)."""
    data = np.zeros((SCAN_ROWS, SCAN_COLUMNS, DETECTOR, DETECTOR), np.uint16)
    for row in range(SCAN_ROWS):
        for column in range(SCAN_COLUMNS):
            data[row, column, 0, 0] = 100 * row + column
    return data


def _session_with(data, lazy):
    session = make_session()
    signal = hs.signals.Signal2D(
        da.from_array(data, chunks=(3, 5, DETECTOR, DETECTOR)) if lazy else data)
    if lazy:
        signal = signal.as_lazy()
    signal.set_signal_type("electron_diffraction")
    session._add_signal(signal)
    return session


def _data_plot(session):
    return next(plot for plot in session._plots
                if not getattr(plot, "is_navigator", False)
                and getattr(getattr(plot, "plot_state", None),
                            "current_signal", None) is not None)


def _navigator_selector(plot):
    selectors = plot.signal_tree.navigator_plot_manager.navigation_selectors
    return next(selector for group in selectors.values() for selector in group)


def _run(action_class, plot, **params):
    from spyde.actions.context import ActionContext
    action = action_class(ActionContext(plot=plot, params=params,
                                        action_name=action_class.name))
    new = action.run(**params)
    assert new is not None, f"{action_class.name} produced no node"
    return new


class TestRebinFieldOrder:
    def test_the_caret_lists_scan_axes_before_diffraction_axes(self):
        from spyde import TOOLBAR_ACTIONS
        parameters = TOOLBAR_ACTIONS["functions"]["Rebin"]["parameters"]
        assert list(parameters) == ["scan_x", "scan_y", "scale_x", "scale_y"]
        assert [spec["name"] for spec in parameters.values()] == [
            "Scan X", "Scan Y", "Diffraction X", "Diffraction Y"]

    def test_the_action_declares_the_same_order(self):
        from spyde.actions.base import Rebin2DAction
        assert list(Rebin2DAction.parameters) == [
            "scan_x", "scan_y", "scale_x", "scale_y"]

    def test_each_factor_bins_its_own_axis(self):
        """Distinct factors on a non-square scan and detector, so a factor
        landing on any other axis changes the shape."""
        from spyde.actions.base import Rebin2DAction
        data = np.zeros((6, 10, 8, 12), np.uint16)
        session = _session_with(data, lazy=False)
        try:
            new = _run(Rebin2DAction, _data_plot(session),
                       scan_x=2, scan_y=3, scale_x=4, scale_y=1)
            # Array order is (scan y, scan x, diffraction y, diffraction x).
            assert new.data.shape == (2, 5, 8, 3)
        finally:
            close_session(session)


@pytest.mark.parametrize("lazy", [False, True], ids=["eager", "lazy"])
class TestTheCrosshairReadsTheBinnedFrameUnderIt:
    def _read(self, plot, column, row):
        from spyde.drawing.update_functions import \
            update_from_navigation_selection
        frame = update_from_navigation_selection(
            _navigator_selector(plot), plot, np.array([[column, row]]))
        return int(np.asarray(frame)[0, 0])

    def test_scan_binned_along_x_only(self, lazy):
        from spyde.actions.base import Rebin2DAction
        data = _named_frames()
        session = _session_with(data, lazy)
        try:
            plot = _data_plot(session)
            binned = _run(Rebin2DAction, plot,
                          scan_x=2, scan_y=1, scale_x=1, scale_y=1)
            expected = np.asarray(binned.data)
            for column, row in [(0, 0), (3, 2), (6, 1), (9, 5)]:
                assert self._read(plot, column, row) == \
                    expected[row, column // 2, 0, 0], (
                        f"crosshair at scan ({column}, {row}) did not read "
                        f"binned ({column // 2}, {row})")
        finally:
            close_session(session)

    def test_scan_binned_along_both_axes(self, lazy):
        from spyde.actions.base import Rebin2DAction
        data = _named_frames()
        session = _session_with(data, lazy)
        try:
            plot = _data_plot(session)
            binned = _run(Rebin2DAction, plot,
                          scan_x=5, scan_y=3, scale_x=1, scale_y=1)
            expected = np.asarray(binned.data)
            for column, row in [(0, 0), (4, 2), (5, 3), (9, 5)]:
                assert self._read(plot, column, row) == \
                    expected[row // 3, column // 5, 0, 0]
        finally:
            close_session(session)

    def test_a_region_integrates_the_binned_positions_it_covers(self, lazy):
        """Scan columns 4..7 of rows 2..3 are binned columns 2..3: the mean of
        those four binned frames, each counted once."""
        from spyde.actions.base import Rebin2DAction
        from spyde.drawing.update_functions import \
            update_from_navigation_selection
        data = _named_frames().astype(np.float32)
        session = _session_with(data, lazy)
        try:
            plot = _data_plot(session)
            binned = _run(Rebin2DAction, plot,
                          scan_x=2, scan_y=1, scale_x=1, scale_y=1)
            region = np.array([[column, row] for row in (2, 3)
                               for column in (4, 5, 6, 7)])
            frame = update_from_navigation_selection(
                _navigator_selector(plot), plot, region)
            expected = np.asarray(binned.data)[2:4, 2:4].mean(axis=(0, 1))
            np.testing.assert_allclose(np.asarray(frame), expected)
        finally:
            close_session(session)

    def test_a_cropped_scan_reads_the_position_under_the_crosshair(self, lazy):
        """The same mismatch for a scan crop: its first position is scan
        (2, 1), not (0, 0)."""
        from spyde.actions.base import CropAction
        data = _named_frames()
        session = _session_with(data, lazy)
        try:
            plot = _data_plot(session)
            _run(CropAction, plot, scan_x0=2, scan_x1=8, scan_y0=1, scan_y1=5)
            for column, row in [(2, 1), (5, 3), (7, 4)]:
                assert self._read(plot, column, row) == 100 * row + column
        finally:
            close_session(session)

    def test_the_unbinned_node_still_reads_its_own_position(self, lazy):
        data = _named_frames()
        session = _session_with(data, lazy)
        try:
            plot = _data_plot(session)
            for column, row in [(0, 0), (3, 2), (9, 5)]:
                assert self._read(plot, column, row) == 100 * row + column
        finally:
            close_session(session)
