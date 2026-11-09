import { useEffect, useState } from 'react';
import { createOwnerAccount, signIn, type AuthState, type AuthUser } from './auth';

export function AuthScreen({ state, onSignedIn }: { state: AuthState; onSignedIn: (user: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lang = document.documentElement.lang === 'en' ? 'en' : 'fr';
  const copy = lang === 'fr'
    ? { title: state.setupRequired ? 'Créer le compte propriétaire' : 'Connexion à l’atelier', email: 'Adresse e-mail', password: 'Mot de passe', code: 'Code affiché dans la fenêtre du serveur', submit: state.setupRequired ? 'Créer le compte' : 'Se connecter', note: state.setupRequired ? 'Créez le compte propriétaire une seule fois. Ensuite, il pourra créer les autres comptes.' : 'Vos projets restent sur le PC serveur et sont accessibles sur ce réseau local.', minimum: '12 caractères minimum', setup: 'Le premier compte administrateur sera créé ici.' }
    : { title: state.setupRequired ? 'Create the owner account' : 'Sign in to the studio', email: 'Email address', password: 'Password', code: 'Code shown in the server window', submit: state.setupRequired ? 'Create account' : 'Sign in', note: state.setupRequired ? 'Create the owner account once. The owner can then create other accounts.' : 'Your projects stay on the host PC and are available on this local network.', minimum: 'At least 12 characters', setup: 'The first administrator account will be created here.' };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = state.setupRequired
        ? await createOwnerAccount({ email, password, setupCode })
        : await signIn({ email, password });
      onSignedIn(result.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  };
  return <main className="auth-page"><form className="auth-card" onSubmit={(event) => void submit(event)}><div className="auth-brand">muse<span>.</span></div><div className="auth-kicker">{state.lanMode ? (lang === 'fr' ? 'ATELIER PRIVÉ · RÉSEAU LOCAL' : 'PRIVATE STUDIO · LOCAL NETWORK') : 'PRIVATE STUDIO'}</div><h1>{copy.title}</h1><p>{copy.note}</p>{state.setupRequired&&<label>{copy.code}<input required autoComplete="off" value={setupCode} onChange={(event)=>setSetupCode(event.target.value)} /></label>}<label>{copy.email}<input type="email" required autoComplete="username" value={email} onChange={(event)=>setEmail(event.target.value)} /></label><label>{copy.password}<input type="password" required minLength={12} maxLength={128} autoComplete={state.setupRequired?'new-password':'current-password'} value={password} onChange={(event)=>setPassword(event.target.value)} /><small>{copy.minimum}</small></label>{error&&<div className="auth-error" role="alert">{error}</div>}<button className="auth-submit" disabled={busy}>{busy ? (lang === 'fr' ? 'Veuillez patienter…' : 'Please wait…') : copy.submit}</button>{state.setupRequired&&<small className="auth-setup-note">{copy.setup}</small>}</form></main>;
}

export function AccountManager({ user, lang, onClose, onLogout }: { user: AuthUser; lang: 'fr' | 'en'; onClose: () => void; onLogout: () => void }) {
  const [users, setUsers] = useState<Array<AuthUser & { createdAt: string }>>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const labels = lang === 'fr'
    ? { title: 'Comptes de l’atelier', owner: 'Propriétaire', member: 'Membre', add: 'Créer un compte', email: 'Adresse e-mail', password: 'Mot de passe temporaire (12 caractères minimum)', create: 'Ajouter', logout: 'Se déconnecter', close: 'Fermer' }
    : { title: 'Studio accounts', owner: 'Owner', member: 'Member', add: 'Create account', email: 'Email address', password: 'Temporary password (at least 12 characters)', create: 'Add account', logout: 'Sign out', close: 'Close' };
  const refreshUsers = async () => {
    const response = await fetch('/api/auth/users');
    const body = await response.json().catch(() => []);
    if (!response.ok) throw new Error(body.error ?? 'Unable to load accounts.');
    setUsers(body);
  };
  useEffect(() => { if (user.role === 'owner') void refreshUsers().catch((requestError) => setError(requestError.message)); }, [user.role]);
  const addUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Unable to create account.');
      setEmail('');
      setPassword('');
      await refreshUsers();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to create account.');
    } finally {
      setBusy(false);
    }
  };
  const removeUser = async (id: string) => {
    if (!window.confirm(lang === 'fr' ? 'Supprimer ce compte et ses projets ?' : 'Delete this account and its projects?')) return;
    const response = await fetch(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? 'Unable to remove account.');
      return;
    }
    await refreshUsers();
  };
  return <div className="auth-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget)onClose()}}><section className="account-modal"><header><div><span>{user.email}</span><h2>{labels.title}</h2></div><button onClick={onClose}>{labels.close}</button></header>{user.role==='owner'&&<><div className="account-list">{users.map((account)=><div key={account.id}><span className="account-avatar">{account.email.slice(0,1).toUpperCase()}</span><div><b>{account.email}</b><small>{account.role==='owner'?labels.owner:labels.member}</small></div>{account.role==='member'&&<button onClick={()=>void removeUser(account.id)} aria-label={`${lang==='fr'?'Supprimer':'Remove'} ${account.email}`}>×</button>}</div>)}</div><form className="account-create" onSubmit={(event)=>void addUser(event)}><h3>{labels.add}</h3><label>{labels.email}<input type="email" required value={email} onChange={(event)=>setEmail(event.target.value)}/></label><label>{labels.password}<input type="password" required minLength={12} maxLength={128} value={password} onChange={(event)=>setPassword(event.target.value)}/></label>{error&&<div className="auth-error" role="alert">{error}</div>}<button className="auth-submit" disabled={busy}>{labels.create}</button></form></>}<footer><button onClick={onLogout}>{labels.logout}</button></footer></section></div>;
}
