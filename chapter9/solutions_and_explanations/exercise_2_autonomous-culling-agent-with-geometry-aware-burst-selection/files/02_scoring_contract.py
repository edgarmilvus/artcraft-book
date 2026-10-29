# clustering/scoring_contract.py
from typing import TypedDict

class ScoreBreakdown(TypedDict):
    sharpness: float        # 0..1 from photo.analyze
    eyes_open: float        # 0..1 mean over detected faces
    horizon_score: float    # 1 - min(|angle|/4, 1)
    composition: float      # 0..1 from subject-center heuristic on preview
    total: float            # weighted sum, weights documented in Exercise prompt

def hero_score(bd: ScoreBreakdown) -> float:
    return (
        + 0.25 * bd["eyes_open"]
        + 0.20 * bd["horizon_score"]
        + 0.15 * bd["composition"]
    )

HYSTERESIS = 0.08  # minimum S_hero - S_runner_up to commit a rejection
