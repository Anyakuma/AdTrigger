/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
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
  AlertCircle,
  Archive,
  StopCircle,
  AudioLines
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { format } from 'date-fns';

// --- Types ---

interface Recording {
  id: string;
  blob: Blob;
  url: string;
  timestamp: Date;
  triggerWord: string;
  duration: number;
}

// Helper to convert Blob to Base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Helper to convert Base64 to Blob
const base64ToBlob = async (base64: string): Promise<Blob> => {
  const res = await fetch(base64);
  return res.blob();
};

// --- Fuzzy Matching ---
const levenshteinDistance = (str1: string, str2: string): number => {
  if (str1.length === 0) return str2.length;
  if (str2.length === 0) return str1.length;

  let prevRow = new Int32Array(str2.length + 1);
  let currRow = new Int32Array(str2.length + 1);

  for (let i = 0; i <= str2.length; i++) prevRow[i] = i;

  for (let i = 0; i < str1.length; i++) {
    currRow[0] = i + 1;
    for (let j = 0; j < str2.length; j++) {
      const cost = str1[i] === str2[j] ? 0 : 1;
      currRow[j + 1] = Math.min(
        currRow[j] + 1,      // insertion
        prevRow[j + 1] + 1,  // deletion
        prevRow[j] + cost    // substitution
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }
  return prevRow[str2.length];
};

const getSoundex = (s: string): string => {
  if (!s) return '';
  const map: { [key: string]: string } = {
    b: '1', f: '1', p: '1', v: '1',
    c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
    d: '3', t: '3',
    l: '4',
    m: '5', n: '5',
    r: '6'
  };
  let soundex = s[0].toUpperCase();
  let prevCode = map[s[0].toLowerCase()] || '0';

  for (let i = 1; i < s.length; i++) {
    const char = s[i].toLowerCase();
    const code = map[char];
    if (code && code !== prevCode) {
      soundex += code;
    }
    prevCode = code || (['a','e','i','o','u','y','h','w'].includes(char) ? '0' : prevCode);
    if (soundex.length === 4) break;
  }
  return (soundex + '000').substring(0, 4);
};

const isFuzzyMatch = (transcript: string, keyword: string): boolean => {
  const t = transcript.toLowerCase();
  const k = keyword.toLowerCase();
  
  // 1. Exact substring match
  if (t.includes(k)) return true;

  // 2. Mashed word match (for extremely fast speech where spaces are dropped)
  const mashedT = t.replace(/[^a-z0-9]/g, '');
  const mashedK = k.replace(/[^a-z0-9]/g, '');
  if (mashedT.includes(mashedK)) return true;

  // 3. Sliding window over mashed transcript (handles multi-word and single-word with heavy errors/fast speech)
  const kMashedLen = mashedK.length;
  if (kMashedLen >= 4) {
    // Allow more errors for longer words to catch radio ad garble
    const allowedMashedDist = kMashedLen <= 5 ? 1 : (kMashedLen <= 8 ? 2 : 3);
    for (let i = 0; i <= mashedT.length - kMashedLen + allowedMashedDist; i++) {
      for (let lenDelta = -allowedMashedDist; lenDelta <= allowedMashedDist; lenDelta++) {
        const subLen = kMashedLen + lenDelta;
        if (subLen < 4 || i + subLen > mashedT.length) continue;
        const subT = mashedT.substring(i, i + subLen);
        if (levenshteinDistance(subT, mashedK) <= allowedMashedDist) {
          return true;
        }
      }
    }
  }

  // 4. Single word fuzzy & phonetic match
  const words = t.split(/[\s,.-]+/);
  // Allow 1 typo for 4-5 letter words, 2 for longer words. No typos for <= 3 letters.
  const maxDistance = k.length <= 3 ? 0 : (k.length <= 5 ? 1 : 2);
  const kWords = k.split(/[\s,.-]+/).filter(w => w.length > 0);

  if (kWords.length === 1) {
    const keywordSoundex = getSoundex(kWords[0].replace(/[^a-z0-9]/g, ''));
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      let cleanWord = '';
      for (let j = 0; j < word.length; j++) {
        const code = word.charCodeAt(j);
        if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
          cleanWord += word[j];
        }
      }
      if (!cleanWord) continue;

      // Phonetic match (Soundex) - catches heavy accents where vowels/soft consonants shift
      if (cleanWord.length > 3 && getSoundex(cleanWord) === keywordSoundex) {
        // Ensure it's not a completely different length word that happens to share a soundex
        if (Math.abs(cleanWord.length - mashedK.length) <= 2) {
          return true;
        }
      }

      if (maxDistance === 0) continue;
      if (Math.abs(cleanWord.length - mashedK.length) > maxDistance) continue;
      if (levenshteinDistance(cleanWord, mashedK) <= maxDistance) {
        return true;
      }
    }
  }
  return false;
};

// Pure JavaScript WAV encoder (no extra packages needed)
const encodeWAV = (samples: Float32Array, sampleRate: number): Blob => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    s = s < -1 ? -1 : (s > 1 ? 1 : s);
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
};
// --- Components ---

// Convert any audio blob (webm) to proper WAV with correct volume
const convertToWAV = async (blob: Blob): Promise<Blob> => {
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  
  const offlineContext = new OfflineAudioContext(
    1,
    audioBuffer.length,
    audioBuffer.sampleRate
  );

  const source = offlineContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineContext.destination);
  source.start();

  const renderedBuffer = await offlineContext.startRendering();
  
  // Encode to WAV
  const wavBlob = encodeAudioBufferToWAV(renderedBuffer);
  return wavBlob;
};

// Simple reliable WAV encoder
const encodeAudioBufferToWAV = (audioBuffer: AudioBuffer): Blob => {
  const numChannels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = audioBuffer.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData = audioBuffer.getChannelData(0);
  let offset = 44;
  for (let i = 0; i < channelData.length; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
};

export default function App() {
  // State
  const [isListening, setIsListening] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [lastDetected, setLastDetected] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState<number>(60);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const keywordsRef = useRef<string[]>(keywords);
  useEffect(() => {
    keywordsRef.current = keywords;
  }, [keywords]);

  const isRecordingRef = useRef(isRecording);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // --- Data Sync ---
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [kwRes, recRes] = await Promise.all([
          fetch('/api/keywords'),
          fetch('/api/recordings')
        ]);
        
        if (kwRes.ok) {
          const kwData = await kwRes.json();
          setKeywords(kwData);
        }
        
        if (recRes.ok) {
          const recData = await recRes.json();
          const parsedRecordings: Recording[] = await Promise.all(
            recData.map(async (r: any) => {
              const blob = await base64ToBlob(r.audioBase64);
              return {
                id: r.id,
                blob,
                url: URL.createObjectURL(blob),
                timestamp: new Date(r.timestamp),
                triggerWord: r.triggerWord,
                duration: r.duration
              };
            })
          );
          setRecordings(parsedRecordings);
        }
      } catch (err) {
        console.error("Failed to fetch data:", err);
      }
    };
    fetchData();
  }, []);

  // Refs
  const recognitionRef = useRef<any>(null);
  const continuousRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rollingBufferRef = useRef<Blob[]>([]);
  const postTriggerCountRef = useRef<number>(0);
  const isListeningRef = useRef(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const currentTriggerRef = useRef<string>('');
  const circularBufferRef = useRef<Float32Array | null>(null);
  const writeHeadRef = useRef(0);
  const preBufferSeconds = 30;

  // --- Audio Visualization ---

  const startVisualizer = useCallback(async (stream: MediaStream) => {
  if (!audioContextRef.current) {
    audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
      latencyHint: 'interactive',   // ← this reduces latency a lot
      sampleRate: 48000
    });
  }
  const ctx = audioContextRef.current;
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512; // better low-frequency resolution
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
const saveRecording = async (audioBlob: Blob, triggerWord: string, duration: number) => {
  let finalBlob = audioBlob;

  // Convert to real WAV if we have PCM data (better quality + Windows compatible)
  if (circularBufferRef.current) {
    const sampleRate = audioContextRef.current?.sampleRate || 48000;
    const samplesToExtract = sampleRate * duration;
    const buffer = circularBufferRef.current;
    const head = writeHeadRef.current;
    const bufferSize = buffer.length;
    
    const extractLen = Math.min(samplesToExtract, bufferSize);
    const extracted = new Float32Array(extractLen);
    
    let startIdx = head - extractLen;
    if (startIdx < 0) {
      startIdx += bufferSize;
      const firstPart = bufferSize - startIdx;
      extracted.set(buffer.subarray(startIdx, bufferSize), 0);
      extracted.set(buffer.subarray(0, head), firstPart);
    } else {
      extracted.set(buffer.subarray(startIdx, head), 0);
    }

    // Normalize volume for excellent quality
    let maxAmp = 0;
    for (let i = 0; i < extracted.length; i++) {
      const abs = Math.abs(extracted[i]);
      if (abs > maxAmp) maxAmp = abs;
    }
    // Only normalize if there's actual audio (above a noise floor) to prevent amplifying static
    if (maxAmp > 0.05 && maxAmp < 1) {
      const multiplier = 0.95 / maxAmp; // Normalize to 95% of max volume
      for (let i = 0; i < extracted.length; i++) {
        extracted[i] *= multiplier;
      }
    }

    const wavBlob = encodeWAV(extracted, sampleRate);
    finalBlob = wavBlob;
  }

  const audioUrl = URL.createObjectURL(finalBlob);
  const newRecording: Recording = {
    id: Math.random().toString(36).substr(2, 9),
    blob: finalBlob,
    url: audioUrl,
    timestamp: new Date(),
    triggerWord: triggerWord,
    duration: duration
  };

  setRecordings(prev => [newRecording, ...prev]);

  // Sync to backend (keep as before)
  try {
    const base64 = await blobToBase64(finalBlob);
    await fetch('/api/recordings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: newRecording.id,
        triggerWord: newRecording.triggerWord,
        duration: newRecording.duration,
        timestamp: newRecording.timestamp.toISOString(),
        audioBase64: base64,
        size: finalBlob.size
      })
    });
  } catch (err) {
    console.error("Failed to sync recording:", err);
  }
};
 

  const stopRecording = useCallback(() => {
    if (isRecordingRef.current) {
      postTriggerCountRef.current = 0;
      const audioBlob = new Blob(rollingBufferRef.current, { type: continuousRecorderRef.current?.mimeType || 'audio/webm' });
      saveRecording(audioBlob, currentTriggerRef.current, rollingBufferRef.current.length);
      rollingBufferRef.current = rollingBufferRef.current.slice(-30);
      setIsRecording(false);
      toast.success('Recording stopped manually and saved.');
    }
  }, []);

 const triggerRecording = useCallback((triggerWord: string) => {
  if (isRecordingRef.current) return;
  setIsRecording(true);
  currentTriggerRef.current = triggerWord;
  postTriggerCountRef.current = recordingDuration * 4; // 250ms chunks
  toast.success(`Trigger detected: "${triggerWord}". Recording started.`);
}, [recordingDuration]);

  // --- Speech Recognition ---

 const toggleListening = () => {
  if (isListening) {
    recognitionRef.current?.stop();
    setIsListening(false);
    isListeningRef.current = false;
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    
    if (continuousRecorderRef.current) {
      continuousRecorderRef.current.stop();
      continuousRecorderRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
    postTriggerCountRef.current = 0;
  } else {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const SpeechGrammarList = (window as any).SpeechGrammarList || (window as any).webkitSpeechGrammarList;
    
    if (!SpeechRecognition) {
      setError("Speech recognition not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    
    if (SpeechGrammarList && keywordsRef.current.length > 0) {
      const speechRecognitionList = new SpeechGrammarList();
      const grammar = '#JSGF V1.0; grammar keywords; public <keyword> = ' + keywordsRef.current.map(k => k.toLowerCase()).join(' | ') + ' ;';
      speechRecognitionList.addFromString(grammar, 1);
      recognition.grammars = speechRecognitionList;
    }

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 10;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      let foundWord = '';
      
      // Build a rolling transcript of the recent audio to catch words split across boundaries
      let recentTranscript = '';
      const startIndex = Math.max(0, event.resultIndex - 1);
      for (let i = startIndex; i < event.results.length; i++) {
        recentTranscript += event.results[i][0].transcript.toLowerCase() + ' ';
      }

      // Also collect all alternatives for the absolute latest result
      const latestResult = event.results[event.results.length - 1];
      const alternatives = [];
      for (let j = 0; j < latestResult.length; j++) {
        alternatives.push(latestResult[j].transcript.toLowerCase());
      }

      for (const word of keywordsRef.current) {
        // 1. Check the concatenated recent transcript
        if (isFuzzyMatch(recentTranscript, word)) {
          foundWord = word;
          break;
        }
        // 2. Check alternatives of the latest phrase
        for (const alt of alternatives) {
          if (isFuzzyMatch(alt, word)) {
            foundWord = word;
            break;
          }
        }
        if (foundWord) break;
      }

      if (foundWord) {
        setLastDetected(foundWord);
        triggerRecording(foundWord);
      }
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === 'not-allowed') setError("Microphone access denied.");
    };

    recognition.onend = () => {
      if (isListeningRef.current) recognition.start();
    };

    recognition.start();
    recognitionRef.current = recognition;
    setIsListening(true);
    isListeningRef.current = true;

    // === LOW-LATENCY MIC + CIRCULAR PRE-BUFFER ===
    navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000,
      
      } 
    }).then(stream => {
      streamRef.current = stream;
      startVisualizer(stream);
      
      const audioCtx = audioContextRef.current!;
      const bufferSize = audioCtx.sampleRate * 70; // 70 seconds total buffer
      circularBufferRef.current = new Float32Array(bufferSize);
      writeHeadRef.current = 0;

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0; // Mute to prevent feedback

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const buffer = circularBufferRef.current!;
        const head = writeHeadRef.current;
        const len = input.length;
        const bufferSize = buffer.length;

        if (head + len <= bufferSize) {
          buffer.set(input, head);
          writeHeadRef.current = (head + len) % bufferSize;
        } else {
          const firstPart = bufferSize - head;
          buffer.set(input.subarray(0, firstPart), head);
          buffer.set(input.subarray(firstPart), 0);
          writeHeadRef.current = len - firstPart;
        }
      };

      source.connect(processor);
      processor.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      continuousRecorderRef.current = mediaRecorder;
      rollingBufferRef.current = [];
      postTriggerCountRef.current = 0;
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          rollingBufferRef.current.push(event.data);
          
          if (postTriggerCountRef.current > 0) {
            postTriggerCountRef.current -= 1;
            if (postTriggerCountRef.current === 0) {
              const audioBlob = new Blob(rollingBufferRef.current, { type: 'audio/webm' });
              saveRecording(audioBlob, currentTriggerRef.current, recordingDuration);
              rollingBufferRef.current = [];
              setIsRecording(false);
              toast.success('Recording completed and saved.');
            }
          } else if (rollingBufferRef.current.length > 120) { // 30s @ 250ms chunks
            rollingBufferRef.current.shift();
          }
        }
      };
      
      mediaRecorder.start(250); // smaller chunks = faster & more accurate
    }).catch(err => {
      console.error("Error accessing microphone:", err);
      setError("Microphone access denied.");
    });
  }
};
  // --- Keyword Management ---

  const addKeyword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newKeyword && !keywords.includes(newKeyword)) {
      const word = newKeyword.trim();
      setKeywords([...keywords, word]);
      setNewKeyword('');
      toast.success(`Keyword "${word}" added`);
      try {
        await fetch('/api/keywords', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ word })
        });
      } catch (err) {
        console.error("Failed to add keyword:", err);
      }
    } else if (keywords.includes(newKeyword)) {
      toast.error('Keyword already exists');
    }
  };

  const removeKeyword = async (word: string) => {
    setKeywords(keywords.filter(k => k !== word));
    toast.info(`Keyword "${word}" removed`);
    try {
      await fetch(`/api/keywords/${encodeURIComponent(word)}`, {
        method: 'DELETE'
      });
    } catch (err) {
      console.error("Failed to remove keyword:", err);
    }
  };

  const deleteRecording = async (id: string) => {
    setRecordings(prev => prev.filter(r => r.id !== id));
    toast.info('Recording deleted');
    try {
      await fetch(`/api/recordings/${id}`, {
        method: 'DELETE'
      });
    } catch (err) {
      console.error("Failed to delete recording:", err);
    }
  };

  const exportAllAsZip = async () => {
    if (recordings.length === 0) return;
    
    const zip = new JSZip();
    
    recordings.forEach((rec) => {
      const filename = `ad_${rec.triggerWord}_${rec.id}.wav`;
      zip.file(filename, rec.blob);
    });
    
    const content = await zip.generateAsync({ type: 'blob' });
    saveAs(content, 'captured_ads.zip');
  };

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 selection:bg-blue-100 selection:text-blue-900">
      <Toaster position="top-center" />
      
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white">
              <Radio size={20} />
            </div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">AdMonitor Pro</h1>
          </div>
          <div className="flex items-center gap-4 text-sm font-medium text-zinc-500">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-300'}`} />
              {isListening ? 'Monitoring Active' : 'Standby'}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Controls & Status */}
        <div className="lg:col-span-4 space-y-6">
          
          {/* Main Control Panel */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-zinc-200 relative overflow-hidden">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900 mb-1">Audio Input</h2>
                <p className="text-xs text-zinc-500">Real-time acoustic analysis</p>
              </div>
              <Mic className={`w-5 h-5 ${isListening ? 'text-blue-600' : 'text-zinc-400'}`} />
            </div>

            {/* Visualizer */}
            <div className="h-24 flex items-end gap-1 mb-6 bg-zinc-50 rounded-xl p-3 border border-zinc-100">
              {Array.from({ length: 24 }).map((_, i) => (
                <motion.div
                  key={i}
                  className={`flex-1 rounded-t-sm ${isListening ? 'bg-blue-500' : 'bg-zinc-200'}`}
                  animate={{ 
                    height: isListening ? `${Math.max(8, audioLevel * (0.4 + Math.random() * 0.6))}%` : '8%',
                    opacity: isListening ? 0.8 + Math.random() * 0.2 : 0.5
                  }}
                  transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                />
              ))}
            </div>

            <button
              onClick={toggleListening}
              className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 ${
                isListening 
                ? 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200' 
                : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm hover:shadow active:scale-[0.98]'
              }`}
            >
              {isListening ? <StopCircle size={18} /> : <Play size={18} />}
              {isListening ? 'Stop Monitoring' : 'Start Monitoring'}
            </button>

            {isRecording && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="absolute inset-0 bg-white/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center border-2 border-red-500 rounded-2xl z-10"
              >
                <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mb-4 animate-pulse">
                  <Mic size={32} />
                </div>
                <h3 className="text-lg font-bold text-zinc-900 mb-1">Recording Segment</h3>
                <p className="text-sm text-zinc-500 mb-6">Trigger detected: <span className="font-semibold text-red-600">"{currentTriggerRef.current}"</span></p>
                <button 
                  onClick={stopRecording}
                  className="px-6 py-2.5 bg-zinc-900 text-white rounded-full font-medium text-sm hover:bg-zinc-800 transition-colors shadow-sm"
                >
                  Stop & Save Now
                </button>
              </motion.div>
            )}
          </div>

          {/* Settings Panel */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-zinc-200">
            <div className="flex items-center gap-2 mb-6">
              <Settings size={18} className="text-zinc-400" />
              <h2 className="text-sm font-semibold text-zinc-900">Configuration</h2>
            </div>
            
            <div className="mb-6">
              <label className="block text-xs font-medium text-zinc-700 mb-2">Recording Duration (Seconds)</label>
              <div className="flex items-center gap-4">
                <input 
                  type="range" 
                  min="10" 
                  max="120" 
                  step="10"
                  value={recordingDuration}
                  onChange={(e) => setRecordingDuration(Number(e.target.value))}
                  className="flex-1 accent-blue-600"
                />
                <span className="text-sm font-semibold text-zinc-900 w-8 text-right">{recordingDuration}s</span>
              </div>
            </div>

            <div className="pt-6 border-t border-zinc-100">
              <label className="block text-xs font-medium text-zinc-700 mb-3">Trigger Keywords</label>
              <form onSubmit={addKeyword} className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  placeholder="Enter brand or phrase..."
                  className="flex-1 bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all"
                />
                <button type="submit" className="px-4 bg-zinc-900 text-white rounded-xl hover:bg-zinc-800 transition-colors font-medium text-sm shadow-sm">
                  Add
                </button>
              </form>

              <div className="flex flex-wrap gap-2">
                {keywords.map(word => (
                  <span 
                    key={word} 
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-100 rounded-lg text-xs font-medium group"
                  >
                    {word}
                    <button onClick={() => removeKeyword(word)} className="text-blue-400 hover:text-blue-800 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </span>
                ))}
                {keywords.length === 0 && (
                  <p className="text-xs text-zinc-400 italic">No keywords configured.</p>
                )}
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex items-start gap-3 text-red-800">
              <AlertCircle size={18} className="shrink-0 mt-0.5 text-red-500" />
              <p className="text-sm font-medium">{error}</p>
            </div>
          )}
        </div>

        {/* Right Column: Recordings Gallery */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border border-zinc-200 overflow-hidden flex flex-col min-h-[600px]">
            <div className="p-5 border-b border-zinc-100 flex justify-between items-center bg-white">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-zinc-50 rounded-xl flex items-center justify-center text-zinc-600 border border-zinc-100">
                  <Archive size={20} />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-zinc-900">Captured Segments</h2>
                  <p className="text-xs text-zinc-500">{recordings.length} recordings found</p>
                </div>
              </div>
              {recordings.length > 0 && (
                <button
                  onClick={exportAllAsZip}
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50 rounded-xl text-sm font-medium transition-colors shadow-sm"
                >
                  <Download size={16} />
                  Export All (ZIP)
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-5 bg-zinc-50/50">
              <AnimatePresence mode="popLayout">
                {recordings.length === 0 ? (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center text-zinc-400 py-24"
                  >
                    <div className="w-16 h-16 bg-zinc-100 rounded-full flex items-center justify-center mb-4">
                      <MicOff size={24} className="text-zinc-300" />
                    </div>
                    <p className="text-sm font-medium text-zinc-600">No recordings yet</p>
                    <p className="text-xs mt-1">Start monitoring to capture audio segments.</p>
                  </motion.div>
                ) : (
                  <div className="space-y-3">
                    {recordings.map((rec) => (
                      <motion.div
                        key={rec.id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98 }}
                        className="group bg-white border border-zinc-200 rounded-xl p-4 hover:border-blue-200 hover:shadow-sm transition-all flex items-center gap-4"
                      >
                        <button 
                          onClick={() => {
                            const audioEl = document.getElementById(`audio-${rec.id}`) as HTMLAudioElement;
                            if (audioEl) {
                              if (playingId === rec.id) {
                                audioEl.pause();
                                setPlayingId(null);
                              } else {
                                // Pause others
                                document.querySelectorAll('audio').forEach(a => a.pause());
                                audioEl.currentTime = 0;
                                audioEl.play();
                                setPlayingId(rec.id);
                              }
                            }
                          }}
                          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors shrink-0 ${
                            playingId === rec.id 
                            ? 'bg-blue-100 text-blue-700' 
                            : 'bg-zinc-50 text-zinc-600 hover:bg-blue-50 hover:text-blue-600 border border-zinc-100'
                          }`}
                        >
                          {playingId === rec.id ? <Square size={18} className="fill-current" /> : <Play size={20} className="ml-1 fill-current" />}
                        </button>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-semibold text-zinc-900 truncate">
                              Trigger: <span className="text-blue-600">"{rec.triggerWord}"</span>
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-zinc-500">
                            <span className="flex items-center gap-1.5">
                              <Clock size={14} />
                              {format(rec.timestamp, 'MMM d, h:mm a')}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <Activity size={14} />
                              {rec.duration.toFixed(1)}s
                            </span>
                            <span className="flex items-center gap-1.5">
                              <AudioLines size={14} />
                              {(rec.blob.size / 1024).toFixed(0)} KB
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                         <button 
                            onClick={async () => {
                              const wavBlob = await convertToWAV(rec.blob);
                              const url = URL.createObjectURL(wavBlob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `ad_${rec.triggerWord}_${rec.id}.wav`;
                              document.body.appendChild(a);
                              a.click();
                              document.body.removeChild(a);
                              URL.revokeObjectURL(url);
                            }}
                            className="p-2.5 text-zinc-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Download WAV"
                          >
                            <Download size={18} />
                          </button>
                          <button 
                            onClick={() => deleteRecording(rec.id)}
                            className="p-2.5 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>

                        <audio 
                          id={`audio-${rec.id}`} 
                          src={rec.url} 
                          className="hidden" 
                          onEnded={() => setPlayingId(null)}
                          onPause={() => setPlayingId(null)}
                        />
                      </motion.div>
                    ))}
                  </div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
