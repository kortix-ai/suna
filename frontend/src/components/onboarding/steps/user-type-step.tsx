'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Building2, User, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StepWrapper } from '../shared/step-wrapper';
import { userContext, updateUserContext } from '../shared/context';

const companySizes = [
  { id: 'solo', label: 'Just me', description: 'Solo founder or freelancer' },
  { id: 'small', label: '2-10 people', description: 'Small team or startup' },
  { id: 'medium', label: '11-50 people', description: 'Growing company' },
  { id: 'large', label: '50+ people', description: 'Established business' }
];

const roles = [
  { id: 'founder', label: 'Founder / CEO', description: 'Leading the company' },
  { id: 'executive', label: 'Executive / VP', description: 'Senior leadership' },
  { id: 'manager', label: 'Manager', description: 'Leading a team' },
  { id: 'contributor', label: 'Team Member', description: 'Individual contributor' }
];

export const UserTypeStep = () => {
  const [step, setStep] = useState<'type' | 'size' | 'role' | 'complete'>('type');
  const [userType, setUserType] = useState<'individual' | 'company' | undefined>(userContext.userType);
  const [companySize, setCompanySize] = useState<string>(userContext.companySize || '');
  const [role, setRole] = useState<string>(userContext.role || '');

  const handleTypeSelect = (type: 'individual' | 'company') => {
    setUserType(type);
    updateUserContext({ userType: type });
    
    if (type === 'individual') {
      // Auto-advance immediately for individuals
      setTimeout(() => {
        // Trigger next step in parent component
        const continueButton = document.querySelector('[data-continue-button]') as HTMLButtonElement;
        continueButton?.click();
      }, 300);
    } else {
      setStep('size');
    }
  };

  const handleSizeSelect = (sizeId: string) => {
    const selectedSize = companySizes.find(s => s.id === sizeId);
    setCompanySize(selectedSize?.label || '');
    updateUserContext({ companySize: selectedSize?.label || '' });
    setStep('role');
  };

  const handleRoleSelect = (roleId: string) => {
    const selectedRole = roles.find(r => r.id === roleId);
    setRole(selectedRole?.label || '');
    updateUserContext({ role: selectedRole?.label || '' });
    
    // Auto-advance immediately after role selection
    setTimeout(() => {
      const continueButton = document.querySelector('[data-continue-button]') as HTMLButtonElement;
      continueButton?.click();
    }, 300);
  };

  return (
    <StepWrapper>
      <div className="max-w-4xl mx-auto">
        <AnimatePresence mode="wait">
          {/* Step 1: User Type Selection */}
          {step === 'type' && (
            <motion.div
              key="type-selection"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.4 }}
              className="text-center space-y-8"
            >
              <div>
                <h1 className="text-4xl font-bold mb-3">Welcome to Kortix</h1>
                <p className="text-lg text-muted-foreground">Choose your account type</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                <Button
                  variant="outline"
                  className="h-32 flex flex-col items-center justify-center space-y-3 text-center hover:border-foreground/50 hover:bg-accent/50 transition-all duration-200"
                  onClick={() => handleTypeSelect('individual')}
                >
                  <User className="h-8 w-8 text-primary" />
                  <div>
                    <div className="font-semibold text-base">Individual</div>
                    <div className="text-sm text-muted-foreground">Personal use</div>
                  </div>
                </Button>

                <Button
                  variant="outline"
                  className="h-32 flex flex-col items-center justify-center space-y-3 text-center hover:border-foreground/50 hover:bg-accent/50 transition-all duration-200"
                  onClick={() => handleTypeSelect('company')}
                >
                  <Building2 className="h-8 w-8 text-primary" />
                  <div>
                    <div className="font-semibold text-base">Company</div>
                    <div className="text-sm text-muted-foreground">Team & business</div>
                  </div>
                </Button>
              </div>
            </motion.div>
          )}

          {/* Step 2: Company Size */}
          {step === 'size' && (
            <motion.div
              key="size-selection"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.4 }}
              className="text-center space-y-6"
            >
              <h2 className="text-3xl font-bold">Company size?</h2>
              
              <div className="grid grid-cols-1 gap-3 max-w-lg mx-auto">
                {companySizes.map((size) => (
                  <Button
                    key={size.id}
                    variant="outline"
                    className="h-16 flex items-center justify-between px-6 hover:border-foreground/50 hover:bg-accent/50 transition-all duration-200"
                    onClick={() => handleSizeSelect(size.id)}
                  >
                    <div className="text-left">
                      <div className="font-semibold">{size.label}</div>
                      <div className="text-sm text-muted-foreground">{size.description}</div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </Button>
                ))}
              </div>
            </motion.div>
          )}

          {/* Step 3: Role Selection */}
          {step === 'role' && (
            <motion.div
              key="role-selection"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.4 }}
              className="text-center space-y-6"
            >
              <h2 className="text-3xl font-bold">What's your role?</h2>
              
              <div className="grid grid-cols-1 gap-3 max-w-lg mx-auto">
                {roles.map((roleOption) => (
                  <Button
                    key={roleOption.id}
                    variant="outline"
                    className="h-16 flex items-center justify-between px-6 hover:border-foreground/50 hover:bg-accent/50 transition-all duration-200"
                    onClick={() => handleRoleSelect(roleOption.id)}
                  >
                    <div className="text-left">
                      <div className="font-semibold">{roleOption.label}</div>
                      <div className="text-sm text-muted-foreground">{roleOption.description}</div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </Button>
                ))}
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </StepWrapper>
  );
};
