import axios from "axios";

export const API_URL = import.meta.env.VITE_API_URL ;

export const http = axios.create({
  baseURL: API_URL,
  headers: {
    "Content-Type": "application/json",
    // Saltea la interstitial page que ngrok (plan free) muestra a browsers.
    // Sin esto, axios recibe HTML en vez de JSON en la primera request.
    "ngrok-skip-browser-warning": "true",
  },
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem("isu_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("isu_token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);
