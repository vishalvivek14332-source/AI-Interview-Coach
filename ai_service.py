"""
ai_service.py — AI Interview Coach
====================================
Centralised AI service layer using the Google Gemini API directly
via the `requests` library (no SDK dependency required).

Set GEMINI_API_KEY in your environment before running.

Public API
----------
  generate_question(job_role, experience_level, question_number,
                    question_type, previous_answers) -> QuestionResult
  evaluate_answer(job_role, experience_level, question_type,
                  question_text, answer_text)         -> EvaluationResult
  generate_summary(job_role, experience_level, responses) -> SummaryResult
  get_provider_name() -> str
  health_check()      -> bool
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Optional

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
_API_KEY   = os.environ.get('GEMINI_API_KEY', '') or os.environ.get('GCP_API_KEY', '')
_MODEL     = 'gemini-2.5-flash'
_API_URL   = f'https://generativelanguage.googleapis.com/v1beta/models/{_MODEL}:generateContent'
_MAX_RETRIES  = 3
_RETRY_DELAY  = 1.5


def get_provider_name() -> str:
    return 'gemini'


# ---------------------------------------------------------------------------
# Return types
# ---------------------------------------------------------------------------

@dataclass
class QuestionResult:
    question:        str
    question_type:   str
    hints:           list = field(default_factory=list)
    question_number: int  = 1

    def to_dict(self) -> dict:
        return {
            'question':        self.question,
            'type':            self.question_type,
            'hints':           self.hints,
            'question_number': self.question_number,
        }


@dataclass
class ScoreBreakdown:
    technical:     float = 5.0
    communication: float = 5.0
    confidence:    float = 5.0
    relevance:     float = 5.0
    completeness:  float = 5.0

    @property
    def overall(self) -> float:
        return round(
            (self.technical + self.communication + self.confidence +
             self.relevance + self.completeness) / 5.0, 2
        )

    def to_dict(self) -> dict:
        return {
            'technical':     self.technical,
            'communication': self.communication,
            'confidence':    self.confidence,
            'relevance':     self.relevance,
            'completeness':  self.completeness,
        }

    @classmethod
    def from_dict(cls, d: dict) -> 'ScoreBreakdown':
        def clamp(v, default=5.0):
            try:
                return max(1.0, min(10.0, float(v)))
            except (TypeError, ValueError):
                return default
        return cls(
            technical=clamp(d.get('technical')),
            communication=clamp(d.get('communication')),
            confidence=clamp(d.get('confidence')),
            relevance=clamp(d.get('relevance')),
            completeness=clamp(d.get('completeness')),
        )


@dataclass
class EvaluationResult:
    scores:         ScoreBreakdown
    strengths:      list = field(default_factory=list)
    weaknesses:     list = field(default_factory=list)
    suggestions:    list = field(default_factory=list)
    brief_feedback: str  = ''

    def to_dict(self) -> dict:
        return {
            'scores':         self.scores.to_dict(),
            'strengths':      self.strengths,
            'weaknesses':     self.weaknesses,
            'suggestions':    self.suggestions,
            'brief_feedback': self.brief_feedback,
        }


@dataclass
class DimensionSummary:
    dimension:     str
    average_score: float
    observations:  list = field(default_factory=list)


@dataclass
class SummaryResult:
    overall_score:         float
    performance_label:     str
    executive_summary:     str
    dimension_summaries:   list = field(default_factory=list)
    top_strengths:         list = field(default_factory=list)
    top_improvements:      list = field(default_factory=list)
    recommended_resources: list = field(default_factory=list)
    hire_recommendation:   str  = 'Maybe'

    def to_dict(self) -> dict:
        return {
            'overall_score':      self.overall_score,
            'performance_label':  self.performance_label,
            'executive_summary':  self.executive_summary,
            'dimension_summaries': [
                {'dimension': ds.dimension,
                 'average_score': ds.average_score,
                 'observations':  ds.observations}
                for ds in self.dimension_summaries
            ],
            'top_strengths':          self.top_strengths,
            'top_improvements':       self.top_improvements,
            'recommended_resources':  self.recommended_resources,
            'hire_recommendation':    self.hire_recommendation,
        }


# ---------------------------------------------------------------------------
# Internal LLM call via requests
# ---------------------------------------------------------------------------

def _call_llm(prompt: str, max_tokens: int = 800, temperature: float = 0.4) -> str:
    """POST to Google Gemini API; return the response text."""
    if not _API_KEY:
        raise RuntimeError(
            'GEMINI_API_KEY environment variable is not set and no fallback key is available.'
        )

    headers = {
        'content-type': 'application/json',
    }
    payload = {
        'contents': [
            {
                'parts': [
                    {
                        'text': prompt
                    }
                ]
            }
        ],
        'generationConfig': {
            'temperature': temperature,
            'maxOutputTokens': max_tokens,
            'responseMimeType': 'application/json',
            'thinkingConfig': {
                'thinkingBudget': 0
            }
        }
    }

    url = f"{_API_URL}?key={_API_KEY}"

    last_exc = None
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            resp = requests.post(url, headers=headers,
                                 json=payload, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                try:
                    return data['candidates'][0]['content']['parts'][0]['text'].strip()
                except (KeyError, IndexError) as exc:
                    raise RuntimeError('Gemini API response format invalid: %s' % data) from exc

            # Hard failures — don't retry
            if resp.status_code in (400, 401, 403):
                raise RuntimeError(
                    'Gemini API error %d: %s' % (resp.status_code, resp.text[:200])
                )

            # Retryable (429, 5xx)
            last_exc = RuntimeError(
                'Gemini API error %d: %s' % (resp.status_code, resp.text[:200])
            )

        except requests.Timeout as exc:
            last_exc = exc
        except requests.ConnectionError as exc:
            last_exc = exc
        except RuntimeError:
            raise
        except Exception as exc:
            last_exc = exc

        if attempt < _MAX_RETRIES:
            delay = _RETRY_DELAY * (2 ** (attempt - 1))
            logger.warning('[ai_service] Attempt %d failed (%s). Retrying in %.1fs...',
                           attempt, last_exc, delay)
            time.sleep(delay)

    raise RuntimeError('Gemini API failed after %d attempts: %s' % (_MAX_RETRIES, last_exc))


def _parse_json(raw: str) -> dict:
    """Extract and parse JSON from LLM response, stripping any markdown fences."""
    text = raw.strip()
    fence = re.compile(r'```(?:json)?\s*([\s\S]*?)```', re.IGNORECASE)
    m = fence.search(text)
    if m:
        text = m.group(1).strip()
    if not text.startswith('{'):
        start = text.find('{')
        end   = text.rfind('}')
        if start != -1 and end != -1:
            text = text[start:end + 1]
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        logger.error('[ai_service] JSON parse failed. Raw:\n%s', raw)
        raise ValueError('Could not parse AI response as JSON: %s' % exc) from exc


def _safe_list(value, max_items: int = 5) -> list:
    if not isinstance(value, list):
        return []
    return [str(i).strip() for i in value[:max_items] if str(i).strip()]


# ---------------------------------------------------------------------------
# Public: generate_question
# ---------------------------------------------------------------------------

_TYPE_ROTATION = [
    'Technical', 'HR', 'Behavioral', 'Technical', 'Technical',
    'Behavioral', 'HR', 'Technical', 'Behavioral', 'HR',
]

_TYPE_INSTRUCTIONS = {
    'Technical':  'ask about coding, system design, or algorithms relevant to the role',
    'HR':         'ask about motivation, career goals, or culture fit',
    'Behavioral': 'use a STAR-method scenario (Situation, Task, Action, Result)',
}

_FALLBACK_QUESTIONS = {
    'Technical':  'Walk me through how you would design a key component of a production system in this role.',
    'HR':         'Tell me about yourself and what draws you to this particular role.',
    'Behavioral': 'Describe a time you had to deliver results under significant time pressure.',
}


def generate_question(
    category: str,
    job_role: str,
    experience_level: str,
    question_number: int = 1,
    question_type: Optional[str] = None,
    previous_answers: Optional[list] = None,
) -> QuestionResult:

    q_type = question_type or _TYPE_ROTATION[(question_number - 1) % len(_TYPE_ROTATION)]

    context = ''
    if previous_answers:
        lines = ['Previous Q&A (adapt difficulty, avoid repetition):']
        for i, pa in enumerate(previous_answers[-3:], 1):
            lines.append('[%d] Q: %s' % (i, (pa.get('question') or '')[:120]))
            lines.append('     A: %s...' % (pa.get('answer') or '')[:200])
        context = '\n'.join(lines)

    # Domain specific topics guidance
    domain_topics = ""
    if job_role == "Civil Engineering":
        domain_topics = "Cover topics such as RCC Design, Surveying, Estimation, Soil Mechanics, or Structural Engineering."
    elif job_role == "Electrical Engineering":
        domain_topics = "Cover topics such as Power Systems, Transformers, Protection Systems, Electrical Machines, or Control Systems."
    elif job_role in ("Electronics and Communication", "Electronics Engineering"):
        domain_topics = "Cover topics such as Digital Electronics, Embedded Systems, VLSI, Communication Systems, or Microcontrollers."
    elif job_role == "Mechanical Engineering":
        domain_topics = "Cover topics such as Thermodynamics, Fluid Mechanics, Manufacturing, CAD/CAM, or Strength of Materials."
    elif job_role in ("Computer Science", "Information Technology", "Artificial Intelligence", "Data Science", "Cyber Security"):
        domain_topics = "Cover topics such as DSA, DBMS, Operating Systems, Computer Networks, OOP, or System Design."

    difficulty_guidance = ""
    if experience_level == "Fresher":
        difficulty_guidance = "Ask basic/beginner level questions focusing on core fundamentals and theoretical knowledge."
    elif experience_level == "Intermediate":
        difficulty_guidance = "Ask intermediate level questions focusing on practical application, problem-solving, and standard industry practices."
    elif experience_level == "Experienced":
        difficulty_guidance = "Ask advanced level questions focusing on system design, architecture, edge cases, leadership, and deep technical depth."

    follow_up_guidance = ""
    if previous_answers:
        follow_up_guidance = (
            "- If appropriate, you may ask a follow-up question based on the candidate's last answer to dig deeper into their response. "
            "For example, ask them to expand on a specific point, justify a design decision, or discuss how they handled a challenge mentioned in their answer."
        )

    prompt = (
        'You are a senior hiring manager in the "%s" field, interviewing a candidate for a "%s" role.\n'
        'Experience Level: %s (%s)\n'
        '%s\n'
        '%s\n\n'
        'Generate exactly ONE %s interview question that:\n'
        '- Is specific to the %s role and appropriate for %s level\n'
        '- %s\n'
        '- %s\n'
        '- Has not been asked in the previous Q&A above\n\n'
        'Also provide 2-3 short hints that guide the candidate WITHOUT giving away the answer.\n\n'
        'Return ONLY valid JSON (no markdown, no extra text):\n'
        '{"question": "...", "type": "%s", "hints": ["hint1", "hint2"]}'
    ) % (
        category, job_role, experience_level, difficulty_guidance,
        domain_topics, context, q_type, job_role,
        experience_level, _TYPE_INSTRUCTIONS.get(q_type, ''),
        follow_up_guidance,
        q_type
    )

    try:
        raw    = _call_llm(prompt, max_tokens=450, temperature=0.7)
        parsed = _parse_json(raw)
        return QuestionResult(
            question=parsed.get('question', '').strip() or _FALLBACK_QUESTIONS.get(q_type, ''),
            question_type=parsed.get('type', q_type),
            hints=_safe_list(parsed.get('hints', []), max_items=3),
            question_number=question_number,
        )
    except Exception as exc:
        logger.warning('[ai_service] generate_question failed: %s. Using fallback.', exc)
        return QuestionResult(
            question=_FALLBACK_QUESTIONS.get(q_type, _FALLBACK_QUESTIONS['HR']),
            question_type=q_type,
            hints=[],
            question_number=question_number,
        )


# ---------------------------------------------------------------------------
# Public: evaluate_answer
# ---------------------------------------------------------------------------

_CALIBRATION = {
    'Fresher':      'Calibrate for 0-1 year experience. Reward solid fundamentals and learning attitude.',
    'Intermediate': 'Calibrate for 1-4 years experience. Expect working knowledge and practical examples.',
    'Experienced':  'Calibrate for 5+ years experience. Expect depth, architecture thinking, leadership examples.',
}


def evaluate_answer(
    category: str,
    job_role: str,
    experience_level: str,
    question_type: str,
    question_text: str,
    answer_text: str,
) -> EvaluationResult:

    prompt = (
        'You are an expert interview evaluator for "%s" roles in the "%s" domain.\n'
        '%s\n\n'
        'QUESTION (%s): %s\n\n'
        'CANDIDATE ANSWER: %s\n\n'
        'Score these five dimensions 1-10 (decimals allowed):\n'
        '1. technical     - accuracy and depth of technical/domain content\n'
        '2. communication - clarity, structure, articulation\n'
        '3. confidence    - assertiveness, concrete language, conviction\n'
        '4. relevance     - how directly the answer addresses the question\n'
        '5. completeness  - thoroughness, examples, edge cases\n\n'
        'Also provide:\n'
        '- strengths: 2-4 specific things done well\n'
        '- weaknesses: 1-3 specific gaps\n'
        '- suggestions: 2-4 actionable improvement tips\n'
        '- brief_feedback: 2-3 sentence plain-text summary (read aloud)\n\n'
        'Return ONLY valid JSON (no markdown):\n'
        '{"scores":{"technical":0,"communication":0,"confidence":0,"relevance":0,"completeness":0},'
        '"strengths":[],"weaknesses":[],"suggestions":[],"brief_feedback":""}'
    ) % (
        job_role, category,
        _CALIBRATION.get(experience_level, _CALIBRATION['Intermediate']),
        question_type, question_text, answer_text
    )

    try:
        raw    = _call_llm(prompt, max_tokens=700, temperature=0.3)
        parsed = _parse_json(raw)
        scores = ScoreBreakdown.from_dict(parsed.get('scores', {}))
        return EvaluationResult(
            scores=scores,
            strengths=_safe_list(parsed.get('strengths', []),   max_items=4),
            weaknesses=_safe_list(parsed.get('weaknesses', []), max_items=3),
            suggestions=_safe_list(parsed.get('suggestions', []), max_items=4),
            brief_feedback=(parsed.get('brief_feedback') or '').strip(),
        )
    except Exception as exc:
        logger.error('[ai_service] evaluate_answer failed: %s', exc)
        return EvaluationResult(
            scores=ScoreBreakdown(),
            strengths=['Answer was provided'],
            weaknesses=['Could not perform detailed AI analysis at this time'],
            suggestions=['Try to be more specific and structured in your answer'],
            brief_feedback=(
                'We could not fully evaluate this answer due to a technical issue. '
                'A neutral score of 5 has been recorded. Please continue.'
            ),
        )


# ---------------------------------------------------------------------------
# Public: generate_summary
# ---------------------------------------------------------------------------

def _score_to_label(score: float) -> str:
    if score >= 9:   return 'Outstanding'
    if score >= 7.5: return 'Excellent'
    if score >= 6:   return 'Good'
    if score >= 4.5: return 'Average'
    return 'Needs Improvement'


def _score_to_recommendation(score: float) -> str:
    if score >= 8.5: return 'Strong Yes'
    if score >= 7.0: return 'Yes'
    if score >= 5.0: return 'Maybe'
    return 'No'


def generate_summary(
    category: str,
    job_role: str,
    experience_level: str,
    responses: list,
) -> SummaryResult:

    if not responses:
        return SummaryResult(
            overall_score=0.0,
            performance_label='Incomplete',
            executive_summary='No responses were recorded for this interview.',
            hire_recommendation='No',
        )

    def mean(key):
        vals = [r.get('scores', {}).get(key, 5.0) for r in responses if r.get('scores')]
        return round(sum(vals) / len(vals), 2) if vals else 5.0

    agg = {
        'technical':     mean('technical'),
        'communication': mean('communication'),
        'confidence':    mean('confidence'),
        'relevance':     mean('relevance'),
        'completeness':  mean('completeness'),
    }
    overall = round(sum(agg.values()) / 5, 2)

    digest_lines = []
    for i, r in enumerate(responses, 1):
        sc  = r.get('scores', {})
        avg = round(sum(sc.values()) / len(sc), 1) if sc else 5.0
        digest_lines.append(
            'Q%d [%s] score=%.1f\n  Q: %s\n  A: %s...' % (
                i, r.get('question_type', '?'), avg,
                (r.get('question_text') or '')[:120],
                (r.get('answer_text')   or '')[:180],
            )
        )

    prompt = (
        'You are writing a post-interview assessment for a "%s" role in the "%s" field (%s level).\n'
        'Overall score: %.2f/10\n'
        'Dimension averages: technical=%.1f communication=%.1f confidence=%.1f '
        'relevance=%.1f completeness=%.1f\n\n'
        'Q&A DIGEST:\n%s\n\n'
        'Write a comprehensive summary. Return ONLY valid JSON (no markdown):\n'
        '{'
        '"performance_label":"<Outstanding|Excellent|Good|Average|Needs Improvement>",'
        '"executive_summary":"<4-5 sentences>",'
        '"dimension_summaries":['
        '{"dimension":"technical","average_score":%.1f,"observations":["..."]},'
        '{"dimension":"communication","average_score":%.1f,"observations":["..."]},'
        '{"dimension":"confidence","average_score":%.1f,"observations":["..."]},'
        '{"dimension":"relevance","average_score":%.1f,"observations":["..."]},'
        '{"dimension":"completeness","average_score":%.1f,"observations":["..."]}'
        '],'
        '"top_strengths":["...","...","..."],'
        '"top_improvements":["...","...","..."],'
        '"recommended_resources":["...","...","..."],'
        '"hire_recommendation":"<Strong Yes|Yes|Maybe|No>"'
        '}'
    ) % (
        job_role, category, experience_level, overall,
        agg['technical'], agg['communication'], agg['confidence'],
        agg['relevance'], agg['completeness'],
        '\n'.join(digest_lines),
        agg['technical'], agg['communication'], agg['confidence'],
        agg['relevance'], agg['completeness'],
    )

    try:
        raw    = _call_llm(prompt, max_tokens=1200, temperature=0.35)
        parsed = _parse_json(raw)

        dim_summaries = []
        for ds in parsed.get('dimension_summaries', []):
            if isinstance(ds, dict):
                dim_summaries.append(DimensionSummary(
                    dimension=str(ds.get('dimension', '')),
                    average_score=float(ds.get('average_score', 5.0)),
                    observations=_safe_list(ds.get('observations', []), max_items=3),
                ))

        existing = {ds.dimension for ds in dim_summaries}
        for dim_name, score in agg.items():
            if dim_name not in existing:
                dim_summaries.append(DimensionSummary(dimension=dim_name,
                                                       average_score=score))

        valid_recs = ('Strong Yes', 'Yes', 'Maybe', 'No')
        hire_rec   = parsed.get('hire_recommendation', 'Maybe')
        if hire_rec not in valid_recs:
            hire_rec = _score_to_recommendation(overall)

        return SummaryResult(
            overall_score=overall,
            performance_label=parsed.get('performance_label', _score_to_label(overall)),
            executive_summary=(parsed.get('executive_summary') or '').strip(),
            dimension_summaries=dim_summaries,
            top_strengths=_safe_list(parsed.get('top_strengths', []),        max_items=3),
            top_improvements=_safe_list(parsed.get('top_improvements', []),  max_items=3),
            recommended_resources=_safe_list(parsed.get('recommended_resources', []), max_items=5),
            hire_recommendation=hire_rec,
        )

    except Exception as exc:
        logger.error('[ai_service] generate_summary failed: %s', exc)
        return SummaryResult(
            overall_score=overall,
            performance_label=_score_to_label(overall),
            executive_summary=(
                'The candidate achieved an overall score of %.1f/10. '
                'Technical: %.1f, Communication: %.1f, Confidence: %.1f.' % (
                    overall, agg['technical'], agg['communication'], agg['confidence']
                )
            ),
            dimension_summaries=[
                DimensionSummary(dimension=k, average_score=v)
                for k, v in agg.items()
            ],
            top_strengths=['Completed the interview session'],
            top_improvements=['Review per-question feedback for specific improvement areas'],
            recommended_resources=[
                'Practice answers using the STAR method',
                'Study core technical concepts for the role',
            ],
            hire_recommendation=_score_to_recommendation(overall),
        )


# ---------------------------------------------------------------------------
# Public: health_check
# ---------------------------------------------------------------------------

def health_check() -> bool:
    try:
        result = _call_llm('Reply with {"ok": true}', max_tokens=50, temperature=0)
        parsed = _parse_json(result)
        return bool(parsed.get('ok'))
    except Exception as exc:
        logger.warning('[ai_service] health_check failed: %s', exc)
        return False
