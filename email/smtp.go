package email

import (
	"fmt"
	"net"
	"net/smtp"

	"github.com/shubhamatkal/OpenMeet/config"
)

// SendVerification sends an email verification link to the user.
func SendVerification(to, name, token string) error {
	verifyURL := fmt.Sprintf("%s/verify-email?token=%s", config.C.AppURL, token)
	subject := "Verify your OpenMeet account"
	body := fmt.Sprintf(`Hi %s,

Welcome to OpenMeet! Please verify your email address by clicking the link below:

  %s

This link expires in 24 hours.

If you didn't create an account, you can safely ignore this email.

— The OpenMeet Team`, name, verifyURL)

	return send(to, subject, body)
}

// SendPasswordReset sends a password reset link to the user.
func SendPasswordReset(to, name, token string) error {
	resetURL := fmt.Sprintf("%s/reset-password?token=%s", config.C.AppURL, token)
	subject := "Reset your OpenMeet password"
	body := fmt.Sprintf(`Hi %s,

We received a request to reset your OpenMeet password. Click the link below to choose a new password:

  %s

This link expires in 1 hour. If you didn't request a password reset, ignore this email.

— The OpenMeet Team`, name, resetURL)

	return send(to, subject, body)
}

func send(to, subject, body string) error {
	c := config.C
	from := c.SMTPFrom
	msg := []byte(fmt.Sprintf(
		"From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s",
		from, to, subject, body,
	))

	addr := fmt.Sprintf("%s:%s", c.SMTPHost, c.SMTPPort)

	// MailHog (port 1025) and similar dev servers: no auth, no TLS
	if c.SMTPPort == "1025" || (c.SMTPUser == "" && c.SMTPPass == "") {
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			return fmt.Errorf("smtp dial: %w", err)
		}
		client, err := smtp.NewClient(conn, c.SMTPHost)
		if err != nil {
			return fmt.Errorf("smtp client: %w", err)
		}
		defer client.Close()
		if err = client.Mail(from); err != nil {
			return err
		}
		if err = client.Rcpt(to); err != nil {
			return err
		}
		w, err := client.Data()
		if err != nil {
			return err
		}
		if _, err = w.Write(msg); err != nil {
			return err
		}
		return w.Close()
	}

	// Production: STARTTLS on port 587
	auth := smtp.PlainAuth("", c.SMTPUser, c.SMTPPass, c.SMTPHost)
	return smtp.SendMail(addr, auth, from, []string{to}, msg)
}
