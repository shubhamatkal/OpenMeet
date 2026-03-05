package main

import (
	"log"
	"net/http"

	"github.com/shubhamatkal/OpenMeet/config"
	"github.com/shubhamatkal/OpenMeet/db"
	"github.com/shubhamatkal/OpenMeet/handlers"
	"github.com/shubhamatkal/OpenMeet/middleware"
)

func main() {
	config.Load()
	db.Connect()

	mux := http.NewServeMux()

	// Redirect email link tokens into the SPA
	mux.HandleFunc("/verify-email", func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		http.Redirect(w, r, "/?verify_token="+token, http.StatusFound)
	})
	mux.HandleFunc("/reset-password", func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		http.Redirect(w, r, "/?reset_token="+token, http.StatusFound)
	})

	// Auth API (public)
	mux.HandleFunc("/api/auth/register", handlers.Register)
	mux.HandleFunc("/api/auth/verify-email", handlers.VerifyEmail)
	mux.HandleFunc("/api/auth/login", handlers.Login)
	mux.HandleFunc("/api/auth/forgot-password", handlers.ForgotPassword)
	mux.HandleFunc("/api/auth/reset-password", handlers.ResetPassword)

	// Auth API (protected)
	mux.Handle("/api/auth/me", middleware.Auth(http.HandlerFunc(handlers.Me)))
	mux.Handle("/api/meet/check", middleware.Auth(http.HandlerFunc(handlers.CheckUserInMeet)))

	// WebSocket signaling (protected)
	mux.Handle("/ws", middleware.Auth(http.HandlerFunc(handlers.HandleWS)))

	// Static files (must be last — catch-all)
	mux.Handle("/", http.FileServer(http.Dir("./static")))

	log.Printf("OpenMeet started → http://localhost:%s", config.C.Port)
	log.Fatal(http.ListenAndServe(":"+config.C.Port, mux))
}
