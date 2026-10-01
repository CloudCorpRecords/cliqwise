import { useEffect, useRef, type ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/app-shell';
import NotFound from '@/pages/not-found';
import Landing from '@/pages/landing';
import Dashboard from '@/pages/dashboard';
import Jobs from '@/pages/jobs';
import JobDetail from '@/pages/job-detail';
import ApiKeys from '@/pages/api-keys';
import Billing from '@/pages/billing';

const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    socialButtonsPlacement: 'top' as const,
    socialButtonsVariant: 'blockButton' as const,
  },
  variables: {
    colorPrimary: '#ee5a2a',
    colorForeground: '#1a1530',
    colorMutedForeground: '#5b5670',
    colorDanger: '#b32020',
    colorBackground: '#fbf7ee',
    colorInput: '#ffffff',
    colorInputForeground: '#1a1530',
    colorNeutral: '#1a1530',
    fontFamily: "'DM Sans', sans-serif",
    borderRadius: '0.5rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fbf7ee] rounded-2xl w-[440px] max-w-full overflow-hidden border-2 border-[#1a1530] shadow-[8px_8px_0_#ee5a2a]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#1a1530] font-extrabold',
    headerSubtitle: 'text-[#5b5670]',
    socialButtonsBlockButtonText: 'text-[#1a1530] font-semibold',
    formFieldLabel: 'text-[#1a1530]',
    footerActionLink: 'text-[#c93f13] font-semibold',
    footerActionText: 'text-[#5b5670]',
    dividerText: 'text-[#5b5670]',
    identityPreviewEditButton: 'text-[#c93f13]',
    formFieldSuccessText: 'text-[#1a1530]',
    alertText: 'text-[#1a1530]',
    logoBox: 'h-12 justify-center',
    logoImage: 'h-12 w-12',
    socialButtonsBlockButton: 'border-2 border-[#1a1530] bg-white',
    formButtonPrimary: 'bg-[#ee5a2a] text-white hover:bg-[#d94c1e]',
    formFieldInput: 'border border-[#1a1530]/40 bg-white',
    footerAction: 'bg-transparent',
    dividerLine: 'bg-[#1a1530]/20',
    alert: 'bg-white border border-[#1a1530]/30',
    otpCodeFieldInput: 'border border-[#1a1530]/40',
    formFieldRow: '',
    main: '',
  },
};

function AuthFrame({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">{children}</div>;
}
const SignInPage = () => <AuthFrame><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></AuthFrame>;
const SignUpPage = () => <AuthFrame><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></AuthFrame>;

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/dashboard" /></Show>
      <Show when="signed-out"><Landing /></Show>
    </>
  );
}

function protect(Page: () => ReactNode) {
  return function Protected() {
    return (
      <>
        <Show when="signed-in"><AppShell><Page /></AppShell></Show>
        <Show when="signed-out"><Redirect to="/" /></Show>
      </>
    );
  };
}
const PDashboard = protect(Dashboard);
const PJobs = protect(Jobs);
const PJob = protect(JobDetail);
const PKeys = protect(ApiKeys);
const PBilling = protect(Billing);

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prev = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    return addListener(({ user }) => {
      const id = user?.id ?? null;
      if (prev.current !== undefined && prev.current !== id) qc.clear();
      prev.current = id;
    });
  }, [addListener, qc]);
  return null;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: 'Back to the studio', subtitle: 'Sign in with Google to open your clips' } },
        signUp: { start: { title: 'Start clipping', subtitle: 'Create your account. 60 free minutes every month.' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route path="/dashboard" component={PDashboard} />
              <Route path="/jobs" component={PJobs} />
              <Route path="/jobs/:id" component={PJob} />
              <Route path="/api-keys" component={PKeys} />
              <Route path="/billing" component={PBilling} />
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
