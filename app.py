"""
app.py — AI Interview Coach
============================
Flask application.  All AI work is delegated to ai_service.py; all
database persistence goes through models.py.  This file contains only
route handlers and application wiring.

Routes
------
  GET  /                         -> index.html
  GET  /interview                -> interview.html
  GET  /report/<id>              -> report.html
  GET  /dashboard                -> dashboard.html

  POST /api/start_interview      -> create Candidate + Interview
  POST /api/generate_question    -> generate question via ai_service + save Question
  POST /api/evaluate_answer      -> evaluate via ai_service + save Answer + Feedback
  POST /api/complete_interview   -> aggregate scores + generate summary
  GET  /api/report/<id>          -> full report JSON
  GET  /api/interviews           -> dashboard list (with optional ?search=)
  GET  /api/certificate/<id>     -> certificate metadata JSON
  GET  /api/health               -> AI provider health-check JSON
"""

import io
import os
import traceback

from flask import Flask, render_template, request, jsonify, send_file

# Database layer
from models import (
    init_db,
    get_or_create_candidate,
    create_interview, get_interview, list_interviews, complete_interview,
    create_question, get_question_by_number,
    create_answer,
    create_feedback,
    build_report_dict,
)

# PDF generation layer
from report_generator      import generate_report_for_interview
from certificate_generator import generate_certificate_for_interview
from email_service         import (
    send_report_email,
    send_certificate_email,
    send_report_and_certificate_email,
    is_configured as email_is_configured,
)

# AI service layer
from ai_service import (
    generate_question  as ai_generate_question,
    evaluate_answer    as ai_evaluate_answer,
    generate_summary   as ai_generate_summary,
    health_check       as ai_health_check,
    get_provider_name,
)


# =============================================================================
# APPLICATION FACTORY
# =============================================================================

def create_app():
    application = Flask(__name__)
    application.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', os.urandom(32))
    init_db()
    return application


app = create_app()


# =============================================================================
# PAGE ROUTES
# =============================================================================

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/interview')
def interview():
    signalling_port = os.environ.get('PIXEL_STREAMING_PLAYER_PORT', '80')
    signalling_url = os.environ.get('METAHUMAN_SIGNALLING_URL', f'ws://127.0.0.1:{signalling_port}')
    default_stream_url = f'http://127.0.0.1:{signalling_port}/uiless.html?AutoConnect=true&AutoPlayAudio=true&HoveringMouse=true'
    stream_url = os.environ.get('METAHUMAN_STREAM_URL', default_stream_url)
    return render_template(
        'interview.html',
        stream_url=stream_url,
        signalling_port=signalling_port,
        signalling_url=signalling_url,
    )


@app.route('/report/<int:interview_id>')
def report(interview_id):
    return render_template('report.html', interview_id=interview_id)


@app.route('/dashboard')
def dashboard():
    return render_template('dashboard.html')


@app.route('/about')
def about():
    return render_template('about.html')


@app.route('/features')
def features():
    from flask import redirect
    return redirect('/about')


# =============================================================================
# API: START INTERVIEW
# =============================================================================

@app.route('/api/start_interview', methods=['POST'])
def api_start_interview():
    """
    Create (or reuse) a Candidate row and open a new Interview session.

    Request  : { name, email, job_role, experience_level }
    Response : { interview_id, message }
    """
    data             = request.get_json(silent=True) or {}
    name             = (data.get('name',             '') or '').strip()
    email            = (data.get('email',            '') or '').strip()
    category         = (data.get('category',         '') or '').strip()
    job_role         = (data.get('job_role',         '') or '').strip()
    experience_level = (data.get('experience_level', '') or '').strip()

    if not all([name, email, category, job_role, experience_level]):
        return jsonify({'error': 'All fields are required.'}), 400

    try:
        candidate = get_or_create_candidate(name=name, email=email)
        iv        = create_interview(
            candidate=candidate,
            category=category,
            job_role=job_role,
            experience_level=experience_level,
        )
        return jsonify({'interview_id': iv.id, 'message': 'Interview started'})

    except Exception:
        traceback.print_exc()
        return jsonify({'error': 'Failed to create interview session.'}), 500


# =============================================================================
# API: GENERATE QUESTION
# =============================================================================

@app.route('/api/generate_question', methods=['POST'])
def api_generate_question():
    """
    Generate an adaptive interview question via ai_service and persist it.

    Request  : { interview_id, question_number, previous_answers[] }
    Response : { question, type, hints[], question_number }
    """
    data             = request.get_json(silent=True) or {}
    interview_id     = data.get('interview_id')
    question_number  = int(data.get('question_number', 1))
    previous_answers = data.get('previous_answers') or []

    iv = get_interview(interview_id)
    if not iv:
        return jsonify({'error': 'Interview not found.'}), 404

    # Delegate to ai_service
    result = ai_generate_question(
        category=iv.category,
        job_role=iv.job_role,
        experience_level=iv.experience_level,
        question_number=question_number,
        previous_answers=previous_answers,
    )

    # Persist Question row (non-fatal on failure)
    try:
        create_question(
            interview=iv,
            question_number=question_number,
            question_text=result.question,
            question_type=result.question_type,
            hints=result.hints,
        )
    except Exception:
        traceback.print_exc()

    return jsonify(result.to_dict())


# =============================================================================
# API: EVALUATE ANSWER
# =============================================================================

@app.route('/api/evaluate_answer', methods=['POST'])
def api_evaluate_answer():
    """
    Evaluate a candidate answer via ai_service; persist Answer + Feedback.

    Request body
    ------------
    {
      interview_id, question_number, question_text,
      question_type, answer_text, input_method (optional)
    }

    Response (identical shape to what interview.js expects)
    --------
    {
      scores: { technical, communication, confidence, relevance, completeness },
      strengths: [], weaknesses: [], suggestions: [], brief_feedback: ""
    }
    """
    data            = request.get_json(silent=True) or {}
    interview_id    = data.get('interview_id')
    question_number = int(data.get('question_number', 1))
    question_text   = (data.get('question_text', '')        or '').strip()
    question_type   = (data.get('question_type', 'General') or 'General').strip()
    answer_text     = (data.get('answer_text', '')          or '').strip()
    input_method    = (data.get('input_method', 'text')     or 'text').strip()

    if not answer_text:
        return jsonify({'error': 'Answer cannot be empty.'}), 400

    iv = get_interview(interview_id)
    if not iv:
        return jsonify({'error': 'Interview not found.'}), 404

    # Delegate evaluation to ai_service
    eval_result = ai_evaluate_answer(
        category=iv.category,
        job_role=iv.job_role,
        experience_level=iv.experience_level,
        question_type=question_type,
        question_text=question_text,
        answer_text=answer_text,
    )

    # Persist Answer + Feedback (non-fatal on failure)
    try:
        question = get_question_by_number(interview_id, question_number)

        if question is None:
            # Fallback: create a minimal Question so the chain stays intact
            question = create_question(
                interview=iv,
                question_number=question_number,
                question_text=question_text,
                question_type=question_type,
                hints=[],
            )

        # Guard against duplicate submissions
        if question.answer is None:
            answer = create_answer(
                question=question,
                answer_text=answer_text,
                input_method=input_method,
            )
        else:
            answer = question.answer

        if answer.feedback is None:
            create_feedback(
                answer=answer,
                scores=eval_result.scores.to_dict(),
                strengths=eval_result.strengths,
                weaknesses=eval_result.weaknesses,
                suggestions=eval_result.suggestions,
                brief_feedback=eval_result.brief_feedback,
            )

    except Exception:
        traceback.print_exc()

    return jsonify(eval_result.to_dict())


# =============================================================================
# API: COMPLETE INTERVIEW
# =============================================================================

@app.route('/api/complete_interview', methods=['POST'])
def api_complete_interview():
    """
    Aggregate per-answer scores, update Interview row, generate AI summary.

    Request  : { interview_id }
    Response : {
        interview_id, overall_score, technical_score,
        communication_score, confidence_score, total_questions,
        summary: { ...SummaryResult... }
    }
    """
    data         = request.get_json(silent=True) or {}
    interview_id = data.get('interview_id')

    iv = get_interview(interview_id)
    if not iv:
        return jsonify({'error': 'Interview not found.'}), 404

    # Aggregate scores and persist to Interview row
    try:
        score_summary = complete_interview(iv)
    except ValueError as ve:
        return jsonify({'error': str(ve)}), 400
    except Exception:
        traceback.print_exc()
        return jsonify({'error': 'Failed to complete interview.'}), 500

    # Build response list from persisted data for the summary prompt
    report_data = build_report_dict(iv)
    responses   = report_data.get('responses', [])

    # Generate AI narrative summary (non-fatal on failure)
    summary_dict = None
    try:
        summary      = ai_generate_summary(
            category=iv.category,
            job_role=iv.job_role,
            experience_level=iv.experience_level,
            responses=responses,
        )
        summary_dict = summary.to_dict()
    except Exception:
        traceback.print_exc()

    return jsonify({**score_summary, 'summary': summary_dict})


# =============================================================================
# API: GET REPORT
# =============================================================================

@app.route('/api/report/<int:interview_id>')
def api_get_report(interview_id):
    """
    Return full interview report JSON.

    Response : { interview: {...}, responses: [{...}, ...] }
    """
    iv = get_interview(interview_id)
    if not iv:
        return jsonify({'error': 'Report not found.'}), 404

    return jsonify(build_report_dict(iv))


# =============================================================================
# API: DASHBOARD LIST
# =============================================================================

@app.route('/api/interviews')
def api_list_interviews():
    """
    Return interviews list for the dashboard, most-recent first.
    Query param: ?search=<str>  (matches candidate name or email)
    """
    search = (request.args.get('search', '') or '').strip()
    try:
        rows = list_interviews(search=search, limit=50)
        return jsonify(rows)
    except Exception:
        traceback.print_exc()
        return jsonify([])


# =============================================================================
# API: CERTIFICATE
# =============================================================================

@app.route('/api/certificate/<int:interview_id>')
def api_get_certificate(interview_id):
    """Return certificate metadata for the frontend to render and print."""
    iv = get_interview(interview_id)
    if not iv:
        return jsonify({'error': 'Interview not found.'}), 404

    return jsonify({
        'certificate':   True,
        'name':          iv.candidate.name  if iv.candidate else '',
        'job_role':      iv.job_role,
        'overall_score': iv.overall_score,
        'completed_at':  iv.completed_at,
        'interview_id':  iv.id,
    })


# =============================================================================
# API: HEALTH CHECK
# =============================================================================

@app.route('/api/health')
def api_health():
    """
    Verify that the configured AI provider is reachable.

    Response : { status: "ok"|"error", provider: str, message: str }
    """
    provider = get_provider_name()
    try:
        ok = ai_health_check()
        if ok:
            return jsonify({
                'status':   'ok',
                'provider': provider,
                'message':  provider + ' is responding normally.',
            })
        return jsonify({
            'status':   'error',
            'provider': provider,
            'message':  provider + ' returned an unexpected response.',
        }), 503
    except Exception as exc:
        return jsonify({
            'status':   'error',
            'provider': provider,
            'message':  str(exc),
        }), 503


# =============================================================================
# API: DOWNLOAD INTERVIEW REPORT PDF
# =============================================================================

@app.route('/api/report/<int:interview_id>/download')
def api_download_report(interview_id):
    """
    Generate and stream the multi-page interview report as a PDF download.

    The PDF is built on-the-fly by report_generator.generate_report_for_interview()
    using the persisted Interview, Questions, Answers, and Feedback rows.
    No file is written to disk; the bytes are streamed directly to the browser.

    Query param (optional):
      summary=1   attach the AI narrative summary stored from /api/complete_interview
                  (the frontend passes this when it has already fetched the summary)

    Response : application/pdf attachment
    """
    iv = get_interview(interview_id)
    if not iv:
        return jsonify({'error': 'Interview not found.'}), 404

    if iv.status != 'completed':
        return jsonify({'error': 'Report is only available for completed interviews.'}), 400

    try:
        pdf_bytes = generate_report_for_interview(interview_id)
    except Exception:
        traceback.print_exc()
        return jsonify({'error': 'Failed to generate report PDF.'}), 500

    filename = 'Interview_Report_%d.pdf' % interview_id
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype='application/pdf',
        as_attachment=True,
        download_name=filename,
    )


# =============================================================================
# API: DOWNLOAD INTERVIEW CERTIFICATE PDF
# =============================================================================

@app.route('/api/certificate/<int:interview_id>/download')
def api_download_certificate(interview_id):
    """
    Generate and stream the single-page completion certificate as a PDF download.

    The certificate is built on-the-fly by
    certificate_generator.generate_certificate_for_interview().

    Response : application/pdf attachment
    """
    iv = get_interview(interview_id)
    if not iv:
        return jsonify({'error': 'Interview not found.'}), 404

    if iv.status != 'completed':
        return jsonify({'error': 'Certificate is only available for completed interviews.'}), 400

    try:
        pdf_bytes = generate_certificate_for_interview(interview_id)
    except ValueError as ve:
        return jsonify({'error': str(ve)}), 400
    except Exception:
        traceback.print_exc()
        return jsonify({'error': 'Failed to generate certificate PDF.'}), 500

    filename = 'Certificate_%d.pdf' % interview_id
    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype='application/pdf',
        as_attachment=True,
        download_name=filename,
    )


# =============================================================================
# API: SEND INTERVIEW REPORT / CERTIFICATE BY EMAIL
# =============================================================================

@app.route('/api/report/<int:interview_id>/email', methods=['POST'])
def api_email_report(interview_id):
    """
    Generate PDFs and email them to the candidate (or an override address).

    Request body (all fields optional except noted)
    -----------------------------------------------
    {
      "to_email":        str   (override recipient; defaults to candidate's email)
      "send_report":     bool  (default true)
      "send_certificate": bool (default false)
    }

    Behaviour:
      - If only send_report is true   → emails the report PDF only.
      - If only send_certificate is true → emails the certificate PDF only.
      - If both are true              → emails both PDFs in a single message.

    Response
    --------
    {
      "sent": bool,
      "to":   str,
      "attachments": ["report" | "certificate"],
      "error": str   (only on failure)
    }
    """
    iv = get_interview(interview_id)
    if not iv:
        return jsonify({'error': 'Interview not found.'}), 404

    if iv.status != 'completed':
        return jsonify({'error': 'Email is only available for completed interviews.'}), 400

    if not email_is_configured():
        return jsonify({
            'error': (
                'Email is not configured. '
                'Set SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD, and EMAIL_FROM '
                'environment variables and restart the server.'
            )
        }), 503

    data             = request.get_json(silent=True) or {}
    candidate_name   = iv.candidate.name  if iv.candidate else 'Candidate'
    candidate_email  = iv.candidate.email if iv.candidate else ''
    to_email         = (data.get('to_email', '') or '').strip() or candidate_email
    send_report      = data.get('send_report',      True)
    send_cert        = data.get('send_certificate', False)

    if not to_email or '@' not in to_email:
        return jsonify({'error': 'A valid recipient email address is required.'}), 400

    if not send_report and not send_cert:
        return jsonify({'error': 'Specify at least one of send_report or send_certificate.'}), 400

    # Generate whichever PDFs are needed
    report_bytes = cert_bytes = None
    attachments_sent = []

    try:
        if send_report:
            report_bytes = generate_report_for_interview(interview_id)
            attachments_sent.append('report')
    except Exception:
        traceback.print_exc()
        return jsonify({'error': 'Failed to generate report PDF.'}), 500

    try:
        if send_cert:
            cert_bytes = generate_certificate_for_interview(interview_id)
            attachments_sent.append('certificate')
    except Exception:
        traceback.print_exc()
        return jsonify({'error': 'Failed to generate certificate PDF.'}), 500

    # Dispatch the appropriate email function
    ok = False
    if send_report and send_cert:
        ok = send_report_and_certificate_email(
            to_email=to_email,
            candidate_name=candidate_name,
            job_role=iv.job_role,
            overall_score=iv.overall_score,
            report_pdf_bytes=report_bytes,
            certificate_pdf_bytes=cert_bytes,
            interview_id=interview_id,
        )
    elif send_report:
        ok = send_report_email(
            to_email=to_email,
            candidate_name=candidate_name,
            job_role=iv.job_role,
            overall_score=iv.overall_score,
            pdf_bytes=report_bytes,
            interview_id=interview_id,
        )
    else:
        ok = send_certificate_email(
            to_email=to_email,
            candidate_name=candidate_name,
            job_role=iv.job_role,
            overall_score=iv.overall_score,
            pdf_bytes=cert_bytes,
            interview_id=interview_id,
        )

    if ok:
        return jsonify({'sent': True, 'to': to_email, 'attachments': attachments_sent})

    return jsonify({
        'sent':  False,
        'to':    to_email,
        'error': 'Failed to send email. Check server logs for details.',
    }), 500


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == '__main__':
    app.run(debug=True, port=5000)
