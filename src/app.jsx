import React, { useState, useCallback, useMemo } from "react";
import {
  Camera,
  Image,
  Search,
  XCircle,
  Loader,
  Film,
  Calendar,
  Users,
  BookOpen,
} from "lucide-react";

// --- CONFIGURATION AND UTILITIES ---

// API key is handled by the environment, kept as an empty string here.
const apiKey = process.env.REACT_APP_API_KEY;
console.log(apiKey);
const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

// Utility to convert File to Base64
const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64String = reader.result.split(",")[1];
      resolve(base64String);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
};

// Exponential backoff retry logic for the API call
async function fetchWithBackoff(url, options, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }

      if (response.status === 429 || response.status >= 500) {
        throw new Error(
          `HTTP error ${response.status}. Attempt ${i + 1}/${retries}.`
        );
      }

      const errorJson = await response.json();
      throw new Error(
        `API Error ${response.status}: ${
          errorJson.error?.message || "Unknown error"
        }`
      );
    } catch (error) {
      if (i === retries - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay * 2 ** i));
    }
  }
}

// Helper function to parse key-value pairs from free-form text
const parseMovieText = (text) => {
  const data = {
    title: "Unknown Movie",
    release_year: "N/A",
    main_actors: "N/A",
    synopsis:
      "Zilla was unable to identify a confident match for this scene. Please try a clearer image.",
    success: false,
  };

  if (!text) return data;

  // Look for common patterns and extract data
  const titleMatch = text.match(/Title:?\s*([^\n]+)/i);
  const yearMatch = text.match(/Year:?\s*(\d{4})/i);
  const actorsMatch = text.match(/Actors:?\s*([^\n]+)/i);
  const synopsisMatch = text.match(/Synopsis:?\s*([^\n]+)/i);

  if (titleMatch) {
    data.title = titleMatch[1].trim().replace(/\*/g, "");
    data.success = true; // Assume success if a title is found
  }
  if (yearMatch) {
    data.release_year = yearMatch[1].trim();
  }
  if (actorsMatch) {
    data.main_actors = actorsMatch[1].trim().replace(/\*/g, "");
  }
  if (synopsisMatch) {
    data.synopsis = synopsisMatch[1].trim().replace(/\*/g, "");
  }

  // Fallback for synopsis if title was found but synopsis pattern wasn't
  if (data.success && data.synopsis.startsWith("Zilla was unable")) {
    // Use the entire first paragraph as a generic summary
    data.synopsis = text.split("\n")[0].trim().replace(/\*/g, "");
  }

  return data;
};

// --- MAIN APP COMPONENT ---

const App = () => {
  const [imageFile, setImageFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [result, setResult] = useState(null); // Stores parsed data { title, year, actors, synopsis, sources, success }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleFileChange = useCallback((event) => {
    const file = event.target.files[0];
    if (file) {
      setImageFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      setResult(null); // Clear previous results
      setError("");
    }
  }, []);

  const handleClearImage = useCallback(() => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setImageFile(null);
    setPreviewUrl("");
    setResult(null);
    setError("");
  }, [previewUrl]);

  const handleIdentifyMovie = useCallback(async () => {
    if (!imageFile) {
      setError("Please upload a movie screenshot first.");
      return;
    }

    setLoading(true);
    setError("");
    setResult(null);

    try {
      const base64Data = await fileToBase64(imageFile);

      // Reverting to a simple, direct prompt that worked before
      const systemPrompt =
        "You are an expert movie recognition AI named Zilla. Analyze the uploaded image, identify the movie, and provide the following details clearly labeled on separate lines: Title, Year, Main Actors, and a brief 1-2 sentence Synopsis. If you cannot identify the movie, state 'Identification Failed' and provide a brief description of the scene instead.";

      const userQuery =
        "Identify the movie shown in this image and provide its details. Use Google Search grounding for accurate, up-to-date information.";

      const payload = {
        contents: [
          {
            role: "user",
            parts: [
              { text: userQuery },
              {
                inlineData: {
                  mimeType: imageFile.type,
                  data: base64Data,
                },
              },
            ],
          },
        ],
        tools: [{ google_search: {} }],
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
      };

      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      };

      const response = await fetchWithBackoff(apiUrl, options);
      const data = await response.json();

      const candidate = data.candidates?.[0];
      const textResponse = candidate?.content?.parts?.[0]?.text || "";

      // Use the reliable text parser to extract data
      const parsedData = parseMovieText(textResponse);

      let sources = [];
      const groundingMetadata = candidate?.groundingMetadata;
      if (groundingMetadata && groundingMetadata.groundingAttributions) {
        sources = groundingMetadata.groundingAttributions
          .map((attr) => ({
            uri: attr.web?.uri,
            title: attr.web?.title,
          }))
          .filter((source) => source.uri && source.title);
      }

      if (parsedData.success) {
        setResult({ ...parsedData, sources });
      } else {
        // If parsing failed or movie was not identified, use the entire response as an error message
        throw new Error(parsedData.synopsis);
      }
    } catch (e) {
      console.error("Movie identification failed:", e);
      // Use the model's descriptive text as the error message if identification failed
      setError(
        `Identification Failed: ${e.message || "Unknown error occurred."}`
      );
    } finally {
      setLoading(false);
    }
  }, [imageFile]);

  // Render logic for the results section
  const ResultsDisplay = useMemo(() => {
    if (error) {
      return (
        <div className="p-4 bg-red-800/30 text-red-200 rounded-xl border border-red-700 animate-fade-in">
          <XCircle className="inline-block w-5 h-5 mr-2" />
          <p className="inline font-medium">{error}</p>
        </div>
      );
    }

    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center p-8 text-purple-400 animate-pulse">
          <Loader className="w-9 h-9 animate-spin" />
          <p className="mt-4 text-lg font-semibold">
            Zilla is analyzing the scene...
          </p>
          <p className="text-sm text-gray-400">
            Searching millions of movie frames.
          </p>
        </div>
      );
    }

    if (result && result.success) {
      return (
        <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-6 rounded-2xl shadow-2xl border border-gray-700 animate-fade-in-up">
          <h2 className="text-3xl font-bold mb-4 text-purple-400 flex items-center">
            <Film className="w-7 h-7 mr-3" /> {result.title}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-gray-200 mb-5">
            <div className="flex items-start bg-gray-700/50 p-3 rounded-xl border border-gray-600">
              <Calendar className="w-5 h-5 mr-3 mt-1 text-purple-300 shrink-0" />
              <div>
                <p className="text-sm text-gray-400">Release Year:</p>
                <p className="font-semibold text-lg">
                  {result.release_year || "N/A"}
                </p>
              </div>
            </div>
            <div className="flex items-start bg-gray-700/50 p-3 rounded-xl border border-gray-600">
              <Users className="w-5 h-5 mr-3 mt-1 text-purple-300 shrink-0" />
              <div>
                <p className="text-sm text-gray-400">Main Actors:</p>
                <p className="font-semibold text-lg">
                  {result.main_actors || "N/A"}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-gray-700/50 p-4 rounded-xl border border-gray-600">
            <h3 className="text-sm text-gray-400 mb-2 flex items-center">
              <BookOpen className="w-4 h-4 mr-2 text-purple-300" /> Synopsis:
            </h3>
            <p className="text-gray-200 leading-relaxed">
              {result.synopsis || "Synopsis not available."}
            </p>
          </div>

          {result.sources && result.sources.length > 0 && (
            <div className="mt-6 pt-4 border-t border-gray-700">
              <h3 className="text-sm font-semibold text-gray-400 mb-2">
                Information Sources:
              </h3>
              <ul className="text-xs text-gray-500 space-y-1">
                {result.sources.map((source, index) => (
                  <li key={index} className="truncate">
                    <a
                      href={source.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-purple-300 transition duration-150 underline-offset-2"
                    >
                      {source.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="p-8 bg-gray-800 rounded-2xl text-center text-gray-400 border border-dashed border-gray-700 animate-fade-in">
        <Search className="w-10 h-10 mx-auto mb-4 text-purple-400" />
        <p className="text-lg font-medium">
          Upload a movie screenshot to unleash Zilla's power!
        </p>
        <p className="text-sm mt-2">
          Get instant movie titles, cast, and plot summaries.
        </p>
      </div>
    );
  }, [loading, error, result]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 to-gray-800 flex flex-col items-center p-4 sm:p-8 font-sans text-gray-100">
      <header className="w-full max-w-4xl text-center mb-10">
        <h1 className="text-5xl sm:text-6xl font-extrabold text-purple-400 mb-3 drop-shadow-lg animate-fade-in-down">
          Zilla
        </h1>
        <p className="text-xl sm:text-2xl text-gray-300 font-light leading-relaxed animate-fade-in">
          Your ultimate AI companion for identifying movies from a single scene.
        </p>
      </header>

      <main className="w-full max-w-4xl space-y-10">
        {/* --- UPLOAD SECTION --- */}
        <section className="bg-gray-900 p-6 sm:p-8 rounded-3xl shadow-3xl border border-gray-700 animate-slide-in-left">
          <h2 className="text-2xl sm:text-3xl font-semibold text-white mb-6 flex items-center">
            <Camera className="w-7 h-7 mr-3 text-purple-400" /> 1. Upload Your
            Scene
          </h2>

          <input
            type="file"
            id="file-upload"
            accept="image/jpeg, image/png, image/webp"
            onChange={handleFileChange}
            className="hidden"
          />

          {previewUrl ? (
            // Image Preview State
            <div className="flex flex-col md:flex-row gap-8">
              <div className="relative w-full md:w-1/2 aspect-video rounded-xl overflow-hidden border-4 border-purple-600 shadow-xl bg-gray-700 flex-shrink-0">
                <img
                  src={previewUrl}
                  alt="Movie Screenshot Preview"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="w-full md:w-1/2 flex flex-col justify-center space-y-5">
                <p className="text-gray-300 font-medium text-lg">
                  Image Ready:{" "}
                  <span className="text-purple-300">{imageFile.name}</span>
                </p>
                <div className="flex flex-col sm:flex-row gap-4">
                  <button
                    onClick={handleClearImage}
                    className="flex-1 px-5 py-3 bg-red-700 hover:bg-red-800 text-white font-semibold rounded-xl transition duration-200 flex items-center justify-center shadow-lg transform hover:scale-105"
                  >
                    <XCircle className="w-5 h-5 mr-2" /> Remove Image
                  </button>
                  <button
                    onClick={handleIdentifyMovie}
                    disabled={loading}
                    className="flex-1 px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold text-lg rounded-xl transition duration-300 shadow-xl shadow-purple-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center transform hover:scale-105"
                  >
                    {loading ? (
                      <>
                        <Loader className="w-5 h-5 animate-spin mr-3" />{" "}
                        Identifying...
                      </>
                    ) : (
                      "Identify Movie with Zilla"
                    )}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            // Initial Upload State
            <label
              htmlFor="file-upload"
              className="flex flex-col items-center justify-center w-full p-12 border-4 border-dashed border-gray-600 rounded-2xl cursor-pointer bg-gray-800/60 hover:bg-gray-800 transition duration-300 group shadow-lg"
            >
              <Image className="w-12 h-12 text-purple-400 mb-4 group-hover:scale-110 transition-transform duration-200" />
              <p className="text-xl font-semibold text-white group-hover:text-purple-300">
                Drag & Drop or Click to Upload
              </p>
              <p className="text-sm text-gray-400 mt-2">
                (Optimal for JPG, PNG, WEBP. Max 4MB)
              </p>
            </label>
          )}
        </section>

        {/* --- RESULTS SECTION --- */}
        <section className="bg-gray-900 p-6 sm:p-8 rounded-3xl shadow-3xl border border-gray-700 animate-slide-in-right">
          <h2 className="text-2xl sm:text-3xl font-semibold text-white mb-6 flex items-center">
            <Film className="w-7 h-7 mr-3 text-purple-400" /> 2. Zilla's
            Identification
          </h2>
          {ResultsDisplay}
        </section>
      </main>

      <footer className="mt-16 text-center text-gray-600 text-sm">
        <p>A product of Daps Technologies</p>
      </footer>

      {/* Custom Tailwind CSS animations */}
      <style jsx>{`
        @keyframes fade-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes fade-in-up {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes fade-in-down {
          from {
            opacity: 0;
            transform: translateY(-20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes slide-in-left {
          from {
            opacity: 0;
            transform: translateX(-50px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        @keyframes slide-in-right {
          from {
            opacity: 0;
            transform: translateX(50px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.5s ease-out forwards;
        }
        .animate-fade-in-up {
          animation: fade-in-up 0.6s ease-out forwards;
        }
        .animate-fade-in-down {
          animation: fade-in-down 0.6s ease-out forwards;
        }
        .animate-slide-in-left {
          animation: slide-in-left 0.7s ease-out forwards;
        }
        .animate-slide-in-right {
          animation: slide-in-right 0.7s ease-out forwards;
        }
      `}</style>
    </div>
  );
};

export default App;
