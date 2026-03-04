package main

import (
	"log"
	"net/http"
)

func main() {
	// Serve everything inside ./static/ at the root URL "/"
	// http.FileServer returns a handler that reads files from disk and sends them to the browser
	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", fs)

	log.Println("OpenMeet started → http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
