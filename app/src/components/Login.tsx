import { useState, type FormEvent } from 'react';
import { signIn } from '../lib/supabase';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      // Pas de redirection a faire : onAuthChange remonte la session a App.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <h1>Reel4me</h1>
      <p className="muted">Ce feed est privé. Connecte-toi pour l'ouvrir.</p>

      <form className="login" onSubmit={submit}>
        <input
          type="email"
          inputMode="email"
          autoComplete="username"
          placeholder="Adresse e-mail"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Connexion…' : 'Entrer'}
        </button>
      </form>

      {error && <p className="login__error">{error}</p>}
    </div>
  );
}
