package config

import (
	"log"
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	MongoURI  string
	JWTSecret string
	SMTPHost  string
	SMTPPort  string
	SMTPUser  string
	SMTPPass  string
	SMTPFrom  string
	AppURL    string
	Port      string
}

var C Config

func Load() {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, reading from environment")
	}
	C = Config{
		MongoURI:  mustEnv("MONGODB_URI"),
		JWTSecret: getEnv("JWT_SECRET", "changeme-set-in-env"),
		SMTPHost:  getEnv("SMTP_HOST", "localhost"),
		SMTPPort:  getEnv("SMTP_PORT", "1025"),
		SMTPUser:  getEnv("SMTP_USER", ""),
		SMTPPass:  getEnv("SMTP_PASS", ""),
		SMTPFrom:  getEnv("SMTP_FROM", "noreply@openmeet.local"),
		AppURL:    getEnv("APP_URL", "http://localhost:8080"),
		Port:      getEnv("PORT", "8080"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("Required environment variable %s is not set", key)
	}
	return v
}
