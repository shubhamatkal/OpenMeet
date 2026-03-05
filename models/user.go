package models

import (
	"time"

	"go.mongodb.org/mongo-driver/bson/primitive"
)

type User struct {
	ID             primitive.ObjectID `bson:"_id,omitempty"          json:"id"`
	Name           string             `bson:"name"                   json:"name"`
	Email          string             `bson:"email"                  json:"email"`
	Password       string             `bson:"password"               json:"-"`
	Avatar         string             `bson:"avatar"                 json:"avatar"` // e.g. "female1.png"
	EmailVerified  bool               `bson:"emailVerified"          json:"emailVerified"`
	VerifyToken    string             `bson:"verifyToken,omitempty"  json:"-"`
	VerifyTokenExp time.Time          `bson:"verifyTokenExp,omitempty" json:"-"`
	ResetToken     string             `bson:"resetToken,omitempty"   json:"-"`
	ResetTokenExp  time.Time          `bson:"resetTokenExp,omitempty" json:"-"`
	CreatedAt      time.Time          `bson:"createdAt"              json:"createdAt"`
}

// SafeUser returns a map safe to send to the client (no password / tokens).
func (u User) SafeUser() map[string]interface{} {
	return map[string]interface{}{
		"id":     u.ID.Hex(),
		"name":   u.Name,
		"email":  u.Email,
		"avatar": u.Avatar,
	}
}
