/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Mic, 
  MicOff, 
  Settings, 
  Play, 
  Square, 
  Trash2, 
  Plus, 
  Volume2, 
  Radio,
  Clock,
  Activity,
  Download,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---

interface Recording {
  id: string;
  blob: Blob;
  url: string;
  timestamp: Date;
  triggerWord: string;
  duration: number;
}

// --- Components ---

export default function App() {
  // State
  const [isListening, setIsListening] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [keywords, setKeywords] = useState<string[]>(['Guinness', 'Hennessy', 'Promotion', 'Sale']);
  const [newKeyword, setNewKeyword] = useState('');
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [lastDetected, setLastDetected] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const currentTriggerRef = useRef<string>('');

  // --- Audio Visualization ---

  const startVisualizer = useCallback(async (stream: MediaStream) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioContextRef.current;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = analyser;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const update = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / bufferLength;
      setAudioLevel(average);
      animationFrameRef.current = requestAnimationFrame(update);
    };
    update();
  }, []);

  // --- Recording Logic ---

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  const startRecording = useCallback((triggerWord: string) => {
    if (isRecording) return;

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];
        currentTriggerRef.current = triggerWord;
        recordingStartTimeRef.current = Date.now();

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
          const audioUrl = URL.createObjectURL(audioBlob);
          const newRecording: Recording = {
            id: Math.random().toString(36).substr(2, 9),
            blob: audioBlob,
            url: audioUrl,
            timestamp: new Date(),
            triggerWord: currentTriggerRef.current,
            duration: (Date.now() - recordingStartTimeRef.current) / 1000
          };
          setRecordings(prev => [newRecording, ...prev]);
        };

        mediaRecorder.start();
        setIsRecording(true);

        // Auto-stop after 15 seconds (typical ad segment length)
        setTimeout(() => {
          stopRecording();
        }, 15000);
      })
      .catch(err => {
        console.error("Error accessing microphone:", err);
        setError("Microphone access denied.");
      });
  }, [isRecording, stopRecording]);

  // --- Speech Recognition ---

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    } else {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) {
        setError("Speech recognition not supported in this browser.");
        return;
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0].transcript)
          .join('')
          .toLowerCase();

        keywords.forEach(word => {
          if (transcript.includes(word.toLowerCase())) {
            setLastDetected(word);
            startRecording(word);
          }
        });
      };

      recognition.onerror = (event: any) => {
        console.error("Speech recognition error:", event.error);
        if (event.error === 'not-allowed') setError("Microphone access denied.");
      };

      recognition.onend = () => {
        if (isListening) recognition.start(); // Keep it alive
      };

      recognition.start();
      recognitionRef.current = recognition;
      setIsListening(true);

      navigator.mediaDevices.getUserMedia({ audio: true }).then(startVisualizer);
    }
  };

  // --- Keyword Management ---

  const addKeyword = (e: React.FormEvent) => {
    e.preventDefault();
    if (newKeyword && !keywords.includes(newKeyword)) {
      setKeywords([...keywords, newKeyword]);
      setNewKeyword('');
    }
  };

  const removeKeyword = (word: string) => {
    setKeywords(keywords.filter(k => k !== word));
  };

  return (
    <div className="min-h-screen bg-[#E6E6E6] p-4 md:p-8 font-mono text-[#151619]">
      <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Column: Controls & Status */}
        <div className="lg:col-span-4 space-y-6">
          
          {/* Main Control Panel */}
          <div className="bg-[#151619] rounded-2xl p-6 shadow-2xl border-b-4 border-[#000] text-white overflow-hidden relative">
            <div className="flex justify-between items-start mb-8">
              <div>
                <h1 className="text-xs uppercase tracking-widest opacity-50 mb-1">System Status</h1>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-red-500'}`} />
                  <span className="text-sm font-bold uppercase tracking-tighter">
                    {isListening ? 'Monitoring Active' : 'System Standby'}
                  </span>
                </div>
              </div>
              <Radio className={`w-5 h-5 ${isListening ? 'text-emerald-400' : 'text-zinc-600'}`} />
            </div>

            {/* Visualizer */}
            <div className="h-24 flex items-end gap-1 mb-8 bg-[#0a0a0a] rounded-lg p-2 border border-white/5">
              {Array.from({ length: 20 }).map((_, i) => (
                <motion.div
                  key={i}
                  className="flex-1 bg-emerald-500/80 rounded-t-sm"
                  animate={{ 
                    height: isListening ? `${Math.max(10, audioLevel * (0.5 + Math.random()))}%` : '5%' 
                  }}
                  transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                />
              ))}
            </div>

            <button
              onClick={toggleListening}
              className={`w-full py-4 rounded-xl font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-3 ${
                isListening 
                ? 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700' 
                : 'bg-emerald-500 text-black hover:bg-emerald-400 active:scale-95'
              }`}
            >
              {isListening ? <MicOff size={20} /> : <Mic size={20} />}
              {isListening ? 'Stop Monitoring' : 'Start Listening'}
            </button>

            {isRecording && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute inset-0 bg-red-600/90 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center"
              >
                <Activity className="w-12 h-12 mb-4 animate-bounce" />
                <h2 className="text-2xl font-black uppercase italic tracking-tighter mb-2">Recording Ad...</h2>
                <p className="text-xs opacity-80 uppercase tracking-widest">Trigger: {currentTriggerRef.current}</p>
                <button 
                  onClick={stopRecording}
                  className="mt-6 px-6 py-2 bg-white text-red-600 rounded-full font-bold uppercase text-xs hover:bg-zinc-100"
                >
                  Manual Stop
                </button>
              </motion.div>
            )}
          </div>

          {/* Keyword Management */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-zinc-200">
            <div className="flex items-center gap-2 mb-4">
              <Settings size={16} className="text-zinc-400" />
              <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Trigger Keywords</h2>
            </div>
            
            <form onSubmit={addKeyword} className="flex gap-2 mb-4">
              <input
                type="text"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                placeholder="Add brand..."
                className="flex-1 bg-zinc-100 border-none rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
              />
              <button type="submit" className="p-2 bg-zinc-900 text-white rounded-lg hover:bg-zinc-800">
                <Plus size={18} />
              </button>
            </form>

            <div className="flex flex-wrap gap-2">
              {keywords.map(word => (
                <span 
                  key={word} 
                  className="inline-flex items-center gap-1 px-3 py-1 bg-zinc-100 rounded-full text-[10px] font-bold uppercase tracking-wider group"
                >
                  {word}
                  <button onClick={() => removeKeyword(word)} className="text-zinc-400 hover:text-red-500">
                    <Trash2 size={12} />
                  </button>
                </span>
              ))}
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-red-700">
              <AlertCircle size={18} className="shrink-0 mt-0.5" />
              <p className="text-xs font-medium">{error}</p>
            </div>
          )}
        </div>

        {/* Right Column: Recordings Gallery */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border border-zinc-200 overflow-hidden flex flex-col min-h-[600px]">
            <div className="p-6 border-bottom border-zinc-100 flex justify-between items-center bg-zinc-50/50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-zinc-900 rounded-lg text-white">
                  <Volume2 size={18} />
                </div>
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-tight">Captured Segments</h2>
                  <p className="text-[10px] text-zinc-400 uppercase tracking-widest">{recordings.length} Recordings found</p>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <AnimatePresence mode="popLayout">
                {recordings.length === 0 ? (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center text-zinc-300 py-20"
                  >
                    <Mic size={48} strokeWidth={1} className="mb-4 opacity-20" />
                    <p className="text-xs uppercase tracking-[0.2em]">Awaiting Triggers...</p>
                  </motion.div>
                ) : (
                  <div className="space-y-4">
                    {recordings.map((rec) => (
                      <motion.div
                        key={rec.id}
                        layout
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="group bg-white border border-zinc-100 rounded-xl p-4 hover:border-emerald-200 hover:shadow-md transition-all flex items-center gap-4"
                      >
                        <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-400 group-hover:bg-emerald-50 group-hover:text-emerald-600 transition-colors">
                          <Play size={18} />
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-black uppercase italic text-emerald-600">
                              {rec.triggerWord}
                            </span>
                            <span className="text-[10px] text-zinc-300">•</span>
                            <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest">
                              {rec.duration.toFixed(1)}s
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] text-zinc-500 uppercase tracking-wider">
                            <span className="flex items-center gap-1">
                              <Clock size={10} />
                              {rec.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <span className="flex items-center gap-1">
                              <Activity size={10} />
                              {(rec.blob.size / 1024).toFixed(0)} KB
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <a 
                            href={rec.url} 
                            download={`ad_${rec.triggerWord}_${rec.id}.wav`}
                            className="p-2 text-zinc-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg"
                          >
                            <Download size={16} />
                          </a>
                          <button 
                            onClick={() => setRecordings(prev => prev.filter(r => r.id !== rec.id))}
                            className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>

                        <audio src={rec.url} className="hidden" />
                      </motion.div>
                    ))}
                  </div>
                )}
              </AnimatePresence>
            </div>

            {/* Footer Status */}
            <div className="p-4 bg-zinc-50 border-t border-zinc-100 flex justify-between items-center">
              <div className="flex items-center gap-4 text-[9px] font-bold uppercase tracking-widest text-zinc-400">
                <span className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Local Storage: Active
                </span>
                <span className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Keyword Engine: Ready
                </span>
              </div>
              <div className="text-[9px] font-bold uppercase tracking-widest text-zinc-300">
                v1.0.4-stable
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
