package db

import (
	"context"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"github.com/shubhamatkal/OpenMeet/config"
)

var Client *mongo.Client

func Connect() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(config.C.MongoURI))
	if err != nil {
		log.Fatal("MongoDB connect error:", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		log.Fatal("MongoDB ping error:", err)
	}
	Client = client
	log.Println("Connected to MongoDB Atlas")

	ensureIndexes()
}

func Users() *mongo.Collection {
	return Client.Database("openmeet").Collection("users")
}

func ensureIndexes() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	idx := mongo.IndexModel{
		Keys:    bson.D{{Key: "email", Value: 1}},
		Options: options.Index().SetUnique(true),
	}
	if _, err := Users().Indexes().CreateOne(ctx, idx); err != nil {
		log.Println("Index creation warning:", err)
	}
}
