package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

var ErrSecretsUnavailable = errors.New("secrets_unavailable")
var ErrSecurityUnavailable = errors.New("security_unavailable")
var ErrProposalRequired = errors.New("proposal_required")

type SecretVault struct{ aead cipher.AEAD }
type credentialValues struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// Configuration is supplied by deployment. No key generation or plaintext fallback.
func NewSecretVault(encoded string) (*SecretVault, error) {
	if encoded == "" {
		return nil, nil
	}
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return nil, ErrSecretsUnavailable
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrSecretsUnavailable
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrSecretsUnavailable
	}
	return &SecretVault{aead}, nil
}
func secretAAD(workspace, role, ref string, version int) []byte {
	return []byte(fmt.Sprintf("whippet-secret-v1:%s:%s:%s:%d", workspace, role, ref, version))
}
func (v *SecretVault) seal(workspace, role, ref string, version int, values credentialValues) ([]byte, []byte, error) {
	if v == nil {
		return nil, nil, ErrSecretsUnavailable
	}
	body, err := json.Marshal(values)
	if err != nil {
		return nil, nil, ErrSecretsUnavailable
	}
	nonce := make([]byte, v.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, nil, ErrSecretsUnavailable
	}
	sealed := v.aead.Seal(nil, nonce, body, secretAAD(workspace, role, ref, version))
	clear(body)
	return nonce, sealed, nil
}

// Internal integrity seam for synthetic-key tests; no HTTP decrypt/resolve API in A.
func (v *SecretVault) open(workspace, role, ref string, version int, nonce, sealed []byte) (credentialValues, error) {
	var values credentialValues
	if v == nil || len(nonce) != v.aead.NonceSize() {
		return values, ErrSecretsUnavailable
	}
	body, err := v.aead.Open(nil, nonce, sealed, secretAAD(workspace, role, ref, version))
	if err != nil {
		return values, ErrSecretsUnavailable
	}
	defer clear(body)
	if json.Unmarshal(body, &values) != nil {
		return credentialValues{}, ErrSecretsUnavailable
	}
	return values, nil
}
