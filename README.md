# 🎯 AI Interview Coach v1.2

<div align="center">

![Python](https://img.shields.io/badge/Python-3.10+-blue?logo=python)
![Flask](https://img.shields.io/badge/Flask-3.x-black?logo=flask)
![SQLite](https://img.shields.io/badge/SQLite-Database-blue?logo=sqlite)
![Unreal Engine](https://img.shields.io/badge/Unreal%20Engine-5.8-black?logo=unrealengine)
![MetaHuman](https://img.shields.io/badge/MetaHuman-Integrated-success)
![Pixel Streaming](https://img.shields.io/badge/Pixel%20Streaming-Streampixel-orange)

**An AI-powered mock interview platform featuring Unreal Engine MetaHuman, adaptive AI interview generation, voice interaction, body language analysis, detailed performance evaluation, and real-time cloud streaming.**

</div>

---

# 📖 Overview

AI Interview Coach is an intelligent mock interview platform that combines modern AI technologies with Unreal Engine MetaHuman to simulate realistic technical and HR interviews.

The platform enables candidates to practice interviews with an AI interviewer while receiving instant evaluation, detailed feedback, and performance analytics.

The interviewer is powered by **Unreal Engine 5.8 MetaHuman** and streamed through **Epic Pixel Streaming**, while the interview logic is handled by a **Python Flask backend**.

---

# ✨ Current Features

## 🤖 AI Interview Engine

- AI-generated interview questions
- Technical, HR and Behavioral interview modes
- Adaptive question difficulty
- Dynamic interview flow
- AI answer evaluation

---

## 🎭 Unreal Engine MetaHuman

- Unreal Engine 
- Streampixel cloud streaming
- Pixel Streaming integration
- Real-time browser streaming
- High-quality 3D interviewer

---

## 🎤 Voice Features

- Browser Speech Recognition
- Microphone support
- Text-to-Speech integration
- Voice-based interview interaction

---

## 📊 Interview Analytics

- AI performance scoring
- Overall interview score
- Question-wise evaluation
- Interview history
- Performance dashboard

---

## 📄 Reports

- AI Interview Report
- Printable Certificate
- Interview Summary
- Feedback Generation

---

## 💻 User Experience

- Responsive interface
- Dark / Light mode
- Modern dashboard
- Clean interview interface

---

# 🏗 System Architecture

```text
                   Candidate
                       │
                       ▼
              Flask Web Application
                       │
      ┌────────────────┼────────────────┐
      ▼                ▼                ▼
 Voice Input      AI Interview      Dashboard
(Web Speech)        Engine         & Reports
      │
      ▼
 Interview Backend (Python)
      │
      ▼
AI Question Generator
      │
      ▼
 Unreal Engine 5.8
     MetaHuman
      │
 Pixel Streaming 2
      │
 Streampixel Cloud
      │
      ▼
 Browser
```

---

# 📂 Project Structure

```text
AI_Interview_Coach/

├── app.py
├── ai_service.py
├── report_generator.py
├── certificate_generator.py
├── email_service.py
├── requirements.txt
├── database.db

├── models/
│   └── __init__.py

├── static/
│   ├── css/
│   │   └── style.css
│   ├── images/
│   └── js/
│       ├── main.js
│       ├── interview.js
│       ├── body_language.js
│       ├── speech.js
│       └── avatar.js

├── templates/
│   ├── index.html
│   ├── interview.html
│   ├── dashboard.html
│   ├── report.html
│   └── certificate.html

├── uploads/

└── Unreal/
    └── MetaHuman Project
```

---

# 🚀 Installation

## Clone Repository

```bash
git clone https://github.com/vishalvivek14332-source/AI-Interview-Coach-.git

cd AI-Interview-Coach-
```

---

## Create Virtual Environment

### Windows

```bash
python -m venv .venv

.venv\Scripts\activate
```

### Linux / macOS

```bash
python3 -m venv .venv

source .venv/bin/activate
```

---

## Install Requirements

```bash
pip install -r requirements.txt
```

---

## Run Application

```bash
python app.py
```

---

## Open Browser

```
http://localhost:5000
```

---

# 🎮 Unreal Engine Integration

The project integrates Unreal Engine MetaHuman using **Pixel Streaming**.

### Technologies

- Unreal Engine 5.8
- MetaHuman
- Pixel Streaming
- Streampixel Cloud Streaming

The MetaHuman is streamed directly into the interview interface using Streampixel.

---

---

# 🌐 API Endpoints

| Method | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/start_interview` | Start interview |
| POST | `/api/generate_question` | Generate AI question |
| POST | `/api/evaluate_answer` | Evaluate candidate answer |
| POST | `/api/complete_interview` | Complete interview |
| GET | `/api/report/<id>` | Generate report |
| GET | `/api/certificate/<id>` | Generate certificate |
| GET | `/api/history` | Interview history |

---

# 🛠 Technology Stack

### Backend

- Python
- Flask
- SQLite

### Frontend

- HTML5
- CSS3
- JavaScript

### AI

- AI Question Generation
- AI Evaluation
- Prompt Engineering

### Speech

- Web Speech API
- Browser Text-to-Speech

### 3D Interviewer

- Unreal Engine 5.8 
- MetaHuman
- Pixel Streaming
- Streampixel

# 📋 Requirements

- Python 3.10+
- Google Chrome / Microsoft Edge
- Microphone
- Unreal Engine 5.8 (for MetaHuman development)
- Streampixel Account (for cloud streaming)

---

# 📸 Features

| Module | Status |
|---------|--------|
| AI Interview | ✅ |
| Adaptive Questions | ✅ |
| Voice Input | ✅ |
| Speech Output | ✅ |
| Dashboard | ✅ |
| Reports | ✅ |
| Certificates | ✅ |
| Interview History | ✅ |
| Unreal MetaHuman | 🚧 |
| Pixel Streaming | ✅ |
| Streampixel Integration | ✅ |
| Body Language Analysis | ✅ |
| Emotion Recognition | 🚧 |
| Eye Tracking | ✅ |
| Resume Analysis | 🚧 |

---

# 🔧 Troubleshooting

## Application won't start

```bash
pip install -r requirements.txt
```

---

## Voice Recognition

- Use Chrome or Microsoft Edge.
- Allow microphone permission.
- Refresh after granting permission.

---


# 🚀 Roadmap

- Runtime MetaHuman speech generation
- Company-specific interview templates
- AI emotion recognition
- Eye contact analysis
- Gesture analysis
- Cloud deployment

---

# 📜 License

This project is developed for educational and research purposes.

---

# 👨‍💻 Author

**Vishal Vivek**

GitHub

https://github.com/vishalvivek14332-source

---

<div align="center">

### ⭐ If you found this project useful, consider giving it a Star!

</div>
