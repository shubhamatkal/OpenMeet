package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"golang.org/x/crypto/bcrypt"

	"github.com/shubhamatkal/OpenMeet/config"
	"github.com/shubhamatkal/OpenMeet/db"
	"github.com/shubhamatkal/OpenMeet/email"
	"github.com/shubhamatkal/OpenMeet/middleware"
	"github.com/shubhamatkal/OpenMeet/models"
)

// validAvatars is the list of allowed avatar filenames served from /avatars/
var validAvatars = map[string]bool{
	"female1.png": true,
	"female2.png": true,
	"male1.png":   true,
	"male2.png":   true,
}

// POST /api/auth/register
func Register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
		Avatar   string `json:"avatar"` // filename, e.g. "female1.png"
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" || req.Email == "" || req.Password == "" {
		jsonErr(w, "name, email and password are required", http.StatusBadRequest)
		return
	}
	if len(req.Password) < 8 {
		jsonErr(w, "password must be at least 8 characters", http.StatusBadRequest)
		return
	}
	if !validAvatars[req.Avatar] {
		jsonErr(w, "invalid avatar selection", http.StatusBadRequest)
		return
	}

	ctx := context.Background()

	var existing models.User
	if err := db.Users().FindOne(ctx, bson.M{"email": req.Email}).Decode(&existing); err == nil {
		jsonErr(w, "email already registered", http.StatusConflict)
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		jsonErr(w, "internal error", http.StatusInternalServerError)
		return
	}

	verifyToken := randomHex(32)
	user := models.User{
		ID:             primitive.NewObjectID(),
		Name:           req.Name,
		Email:          req.Email,
		Password:       string(hash),
		Avatar:         req.Avatar,
		EmailVerified:  false,
		VerifyToken:    verifyToken,
		VerifyTokenExp: time.Now().Add(24 * time.Hour),
		CreatedAt:      time.Now(),
	}

	if _, err := db.Users().InsertOne(ctx, user); err != nil {
		jsonErr(w, "internal error", http.StatusInternalServerError)
		return
	}

	go email.SendVerification(user.Email, user.Name, verifyToken)

	jsonOK(w, map[string]string{"message": "Registration successful. Please check your email to verify your account."})
}

// POST /api/auth/verify-email
func VerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		jsonErr(w, "token is required", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	var user models.User
	err := db.Users().FindOne(ctx, bson.M{
		"verifyToken":    req.Token,
		"verifyTokenExp": bson.M{"$gt": time.Now()},
	}).Decode(&user)
	if err != nil {
		jsonErr(w, "invalid or expired verification link", http.StatusBadRequest)
		return
	}

	_, err = db.Users().UpdateOne(ctx, bson.M{"_id": user.ID}, bson.M{
		"$set":   bson.M{"emailVerified": true},
		"$unset": bson.M{"verifyToken": "", "verifyTokenExp": ""},
	})
	if err != nil {
		jsonErr(w, "internal error", http.StatusInternalServerError)
		return
	}

	tokenStr, err := issueJWT(user.ID.Hex())
	if err != nil {
		jsonErr(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{"token": tokenStr, "user": user.SafeUser()})
}

// POST /api/auth/login
func Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		jsonErr(w, "email and password are required", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	var user models.User
	if err := db.Users().FindOne(ctx, bson.M{"email": req.Email}).Decode(&user); err != nil {
		jsonErr(w, "invalid email or password", http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(req.Password)); err != nil {
		jsonErr(w, "invalid email or password", http.StatusUnauthorized)
		return
	}

	if !user.EmailVerified {
		jsonErr(w, "Please verify your email before signing in.", http.StatusForbidden)
		return
	}

	tokenStr, err := issueJWT(user.ID.Hex())
	if err != nil {
		jsonErr(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{"token": tokenStr, "user": user.SafeUser()})
}

// POST /api/auth/forgot-password
func ForgotPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" {
		jsonErr(w, "email is required", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	var user models.User
	if err := db.Users().FindOne(ctx, bson.M{"email": req.Email}).Decode(&user); err != nil {
		// Don't reveal whether the email exists
		jsonOK(w, map[string]string{"message": "If that email is registered, a reset link has been sent."})
		return
	}

	resetToken := randomHex(32)
	_, _ = db.Users().UpdateOne(ctx, bson.M{"_id": user.ID}, bson.M{
		"$set": bson.M{
			"resetToken":    resetToken,
			"resetTokenExp": time.Now().Add(time.Hour),
		},
	})

	go email.SendPasswordReset(user.Email, user.Name, resetToken)

	jsonOK(w, map[string]string{"message": "If that email is registered, a reset link has been sent."})
}

// POST /api/auth/reset-password
func ResetPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" || req.Password == "" {
		jsonErr(w, "token and password are required", http.StatusBadRequest)
		return
	}
	if len(req.Password) < 8 {
		jsonErr(w, "password must be at least 8 characters", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	var user models.User
	err := db.Users().FindOne(ctx, bson.M{
		"resetToken":    req.Token,
		"resetTokenExp": bson.M{"$gt": time.Now()},
	}).Decode(&user)
	if err != nil {
		jsonErr(w, "invalid or expired reset link", http.StatusBadRequest)
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		jsonErr(w, "internal error", http.StatusInternalServerError)
		return
	}

	_, err = db.Users().UpdateOne(ctx, bson.M{"_id": user.ID}, bson.M{
		"$set":   bson.M{"password": string(hash)},
		"$unset": bson.M{"resetToken": "", "resetTokenExp": ""},
	})
	if err != nil {
		jsonErr(w, "internal error", http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]string{"message": "Password updated successfully. You can now sign in."})
}

// GET /api/auth/me  (protected)
func Me(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(middleware.UserIDKey).(string)
	oid, err := primitive.ObjectIDFromHex(userID)
	if err != nil {
		jsonErr(w, "invalid user id", http.StatusBadRequest)
		return
	}

	var user models.User
	if err := db.Users().FindOne(context.Background(), bson.M{"_id": oid}).Decode(&user); err != nil {
		jsonErr(w, "user not found", http.StatusNotFound)
		return
	}

	jsonOK(w, user.SafeUser())
}

// --- helpers ---

func issueJWT(userID string) (string, error) {
	claims := jwt.MapClaims{
		"sub": userID,
		"exp": time.Now().Add(30 * 24 * time.Hour).Unix(),
		"iat": time.Now().Unix(),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(config.C.JWTSecret))
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func jsonErr(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
